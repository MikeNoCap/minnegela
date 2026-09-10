"""`recluster` job: load the group's timeline window, run WBS, persist events/event_assets/moments
with stable ids and constraints (DESIGN §9.8-9.9), enqueue titles."""
from __future__ import annotations

import datetime as dt
import logging
import zoneinfo

import numpy as np

from minnegela_ml.db import vec

from .. import db, queue
from ..constants import WBS
from ..wbs import Constraints, ExistingEvent, Item, segment

log = logging.getLogger(__name__)
UTC = dt.timezone.utc


def tz_for(center: tuple[float, float] | None) -> str:
    """Coarse GPS→timezone without a dependency. Europe/Oslo is the group's home fallback."""
    if center is None:
        return "Europe/Oslo"
    lat, lon = center
    boxes = [
        ("Europe/London", 49.5, 61.0, -11.0, 2.0),
        ("Europe/Lisbon", 36.0, 42.5, -10.0, -6.0),
        ("Europe/Oslo", 35.0, 72.0, -6.0, 32.0),      # CET/CEST for most of the continent
        ("Europe/Helsinki", 59.0, 71.0, 20.0, 32.0),
        ("Europe/Istanbul", 35.5, 42.5, 25.5, 45.0),
        ("America/New_York", 24.0, 50.0, -85.0, -66.0),
        ("America/Chicago", 25.0, 50.0, -105.0, -85.0),
        ("America/Denver", 30.0, 50.0, -115.0, -105.0),
        ("America/Los_Angeles", 30.0, 50.0, -130.0, -115.0),
        ("Asia/Tokyo", 30.0, 46.0, 128.0, 146.0),
        ("Asia/Bangkok", 5.0, 21.0, 97.0, 107.0),
        ("Australia/Sydney", -44.0, -10.0, 140.0, 155.0),
    ]
    # more specific boxes first
    for name, lat0, lat1, lon0, lon1 in [boxes[0], boxes[1], boxes[3], boxes[4], *boxes[5:], boxes[2]]:
        if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
            return name
    offset = round(lon / 15.0)
    return f"Etc/GMT{'-' if offset > 0 else '+'}{abs(offset)}" if offset else "UTC"


def _load_window(conn, group_id: str, payload: dict) -> tuple[dt.datetime | None, dt.datetime | None]:
    if payload.get("full"):
        return None, None
    have = conn.execute("select 1 from events where group_id = %s and deleted_at is null limit 1", (group_id,)).fetchone()
    if not have or not payload.get("from") or not payload.get("to"):
        return None, None
    pad = dt.timedelta(hours=WBS["recluster_pad_hours"])
    lo = dt.datetime.fromisoformat(payload["from"]).astimezone(UTC) - pad
    hi = dt.datetime.fromisoformat(payload["to"]).astimezone(UTC) + pad
    # widen to whole intersecting events
    r = conn.execute(
        "select min(start_at) as s, max(end_at) as e from events where group_id = %s and deleted_at is null and start_at <= %s and end_at >= %s",
        (group_id, hi, lo),
    ).fetchone()
    if r and r["s"] is not None:
        lo, hi = min(lo, r["s"]), max(hi, r["e"])
    return lo, hi


def _load_items(conn, group_id: str, lo, hi) -> tuple[list[Item], dict[str, list[str]]]:
    where = "a.group_id = %s and a.deleted_at is null and a.visibility = 'group' and b.is_utility = false and b.captured_at is not null"
    params: list = [group_id]
    if lo is not None:
        where += " and (b.captured_at + make_interval(secs => d.clock_offset_s)) between %s and %s"
        params += [lo, hi]
    rows = conn.execute(
        f"""
        select a.id as asset_id, a.blob_id, a.owner_user_id, a.person_ids, a.origin,
               extract(epoch from b.captured_at + make_interval(secs => d.clock_offset_s)) as t,
               b.lat, b.lon, b.clip_emb, b.n_faces, b.time_uncertain, b.duration_ms, b.tags
        from assets a join blobs b on b.id = a.blob_id join devices d on d.id = a.device_id
        where {where}
        order by t, a.id
        """,
        params,
    ).fetchall()
    # one blob participates once (§7.4); every asset of it inherits the membership
    assets_of_blob: dict[str, list[str]] = {}
    items: list[Item] = []
    for r in rows:
        bid = str(r["blob_id"])
        assets_of_blob.setdefault(bid, []).append(str(r["asset_id"]))
        if len(assets_of_blob[bid]) > 1:
            continue
        emb = None if r["clip_emb"] is None else vec(r["clip_emb"])
        tags = {t["tag"]: float(t["score"]) for t in (r["tags"] or []) if isinstance(t, dict)}
        items.append(Item(
            id=str(r["asset_id"]), blob_id=bid, t=float(r["t"]), contrib=str(r["owner_user_id"]),
            lat=r["lat"], lon=r["lon"], people=frozenset(int(p) for p in (r["person_ids"] or [])),
            emb=emb, n_faces=int(r["n_faces"] or 0), time_uncertain=bool(r["time_uncertain"]),
            is_video=r["duration_ms"] is not None, tags=tags, origin=str(r["origin"] or "unknown"),
        ))
    return items, assets_of_blob


def _load_existing(conn, group_id: str, lo, hi) -> list[ExistingEvent]:
    where = "e.group_id = %s and e.deleted_at is null"
    params: list = [group_id]
    if lo is not None:
        where += " and e.start_at <= %s and e.end_at >= %s"
        params += [hi, lo]
    rows = conn.execute(
        f"""
        select e.id, extract(epoch from e.start_at) as s, extract(epoch from e.end_at) as e_, e.frozen, e.kind,
               coalesce(array_agg(ea.asset_id) filter (where ea.asset_id is not null), '{{}}') as asset_ids
        from events e left join event_assets ea on ea.event_id = e.id
        where {where} group by e.id
        """,
        params,
    ).fetchall()
    return [ExistingEvent(str(r["id"]), float(r["s"]), float(r["e_"]), frozenset(str(a) for a in r["asset_ids"]), bool(r["frozen"]), r["kind"]) for r in rows]


def _load_constraints(conn, group_id: str, existing: list[ExistingEvent]) -> Constraints:
    c = Constraints()
    frozen_ids: set[str] = set()
    for r in conn.execute("select kind, event_id, at, asset_ids from event_constraints where group_id = %s", (group_id,)):
        k = r["kind"]
        if k == "pin_boundary" and r["at"] is not None:
            c.pin_boundaries.append(r["at"].timestamp())
        elif k == "keep_together" and r["asset_ids"]:
            c.keep_together.append(frozenset(str(a) for a in r["asset_ids"]))
        elif k == "exclude" and r["event_id"] and r["asset_ids"]:
            c.exclude.setdefault(str(r["event_id"]), set()).update(str(a) for a in r["asset_ids"])
        elif k == "include" and r["event_id"] and r["asset_ids"]:
            c.include.setdefault(str(r["event_id"]), set()).update(str(a) for a in r["asset_ids"])
        elif k == "frozen" and r["event_id"]:
            frozen_ids.add(str(r["event_id"]))
    for ev in existing:
        if ev.id in frozen_ids:
            ev.frozen = True
    return c


def run_recluster(payload: dict) -> dict:
    group_id = payload["groupId"]
    with db.connect() as conn, conn.transaction():
        lo, hi = _load_window(conn, group_id, payload)
        items, assets_of_blob = _load_items(conn, group_id, lo, hi)
        existing = _load_existing(conn, group_id, lo, hi)
        constraints = _load_constraints(conn, group_id, existing)
        # local-day offset for collapsing loose photos: from the group's most common timezone guess
        gps = [(it.lat, it.lon) for it in items if it.has_gps]
        tzname = tz_for((float(np.median([g[0] for g in gps])), float(np.median([g[1] for g in gps]))) if gps else None)
        ref = dt.datetime.fromtimestamp(items[0].t, zoneinfo.ZoneInfo(tzname)) if items else dt.datetime.now(zoneinfo.ZoneInfo(tzname))
        tz_offset = ref.utcoffset().total_seconds() if ref.utcoffset() else 0.0

        res = segment(items, constraints, existing, tz_offset_s=tz_offset)

        touched: list[str] = []
        for ev in res.events:
            tz = tz_for(ev.center)
            start = dt.datetime.fromtimestamp(ev.start, UTC)
            end = dt.datetime.fromtimestamp(ev.end, UTC)
            splits = [dt.datetime.fromtimestamp(s, UTC) for s in ev.suggested_splits]
            lat, lon = (ev.center if ev.center else (None, None))
            if ev.is_new:
                conn.execute(
                    "insert into events (id, group_id, kind, start_at, end_at, tz, center_lat, center_lon, confidence, suggested_splits, algo_version) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz[], %s)",
                    (ev.id, group_id, ev.kind, start, end, tz, lat, lon, ev.confidence, splits, WBS["algo_version"]),
                )
            else:
                conn.execute(
                    "update events set kind = %s, start_at = %s, end_at = %s, tz = %s, center_lat = %s, center_lon = %s, confidence = %s, "
                    "suggested_splits = %s::timestamptz[], algo_version = %s, deleted_at = null, updated_at = now() where id = %s",
                    (ev.kind, start, end, tz, lat, lon, ev.confidence, splits, WBS["algo_version"], ev.id),
                )
                conn.execute("delete from event_assets where event_id = %s", (ev.id,))
                conn.execute("delete from moments where event_id = %s", (ev.id,))
            rows = []
            for m in ev.members:
                for asset_id in assets_of_blob.get(m.blob_id, [m.asset_id]):
                    rows.append((ev.id, asset_id, m.blob_id, m.confidence, m.tier, m.source))
            conn.cursor().executemany(
                "insert into event_assets (event_id, asset_id, blob_id, confidence, tier, source) values (%s, %s, %s, %s, %s, %s) on conflict do nothing",
                rows,
            )
            for mo in ev.moments:
                conn.execute(
                    "insert into moments (event_id, start_at, end_at, label, n_assets, blob_ids, center_lat, center_lon) values (%s, %s, %s, %s, %s, %s::uuid[], %s, %s)",
                    (ev.id, dt.datetime.fromtimestamp(mo.start, UTC), dt.datetime.fromtimestamp(mo.end, UTC), mo.label, len(mo.blob_ids), mo.blob_ids,
                     mo.center[0] if mo.center else None, mo.center[1] if mo.center else None),
                )
            # cover: middle member for now; the titles job refines it
            mid = ev.members[len(ev.members) // 2]
            conn.execute("update events set cover_blob_id = coalesce(cover_blob_id, %s) where id = %s", (mid.blob_id, ev.id))
            touched.append(ev.id)
        if res.deleted_event_ids:
            conn.execute("delete from event_assets where event_id = any(%s::uuid[])", (res.deleted_event_ids,))
            conn.execute("delete from moments where event_id = any(%s::uuid[])", (res.deleted_event_ids,))
            conn.execute("update events set deleted_at = now(), updated_at = now() where id = any(%s::uuid[])", (res.deleted_event_ids,))
        if touched:
            queue.enqueue(conn, "titles", {"groupId": group_id, "eventIds": touched})
        cuts = sum(1 for b in res.boundaries if b.cut)
        summary = {"window": [lo.isoformat() if lo else None, hi.isoformat() if hi else None], "assets": sum(len(v) for v in assets_of_blob.values()),
                   "blobs": len(items), "events": len([e for e in res.events if e.kind == "event"]), "loose": len([e for e in res.events if e.kind == "loose"]),
                   "reused_ids": len([e for e in res.events if not e.is_new]), "deleted": len(res.deleted_event_ids), "cuts": cuts}
        log.info("recluster %s: %s", group_id, summary)
        return summary
