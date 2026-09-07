"""Windowed Boundary Segmentation (DESIGN §9). Pure numpy; no database access, so the whole
algorithm is unit-testable on synthetic timelines.

Pipeline:  sort → pass 1 (boundary scores + constraints) → pass 2 (over-long cut, concurrent split,
min size, adjacent merge) → moments → membership confidence → stable ids → include/exclude.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np

from .constants import WBS
from .geo import centroid, haversine_m, to_local_xy

# ----------------------------------------------------------------------------- inputs

@dataclass
class Item:
    id: str                       # asset id
    blob_id: str
    t: float                      # corrected epoch seconds
    contrib: str                  # owner user id
    lat: float | None = None
    lon: float | None = None
    people: frozenset[int] = frozenset()
    emb: np.ndarray | None = None  # 512-d, normalized
    n_faces: int = 0
    time_uncertain: bool = False
    is_video: bool = False
    tags: dict[str, float] = field(default_factory=dict)

    @property
    def has_gps(self) -> bool:
        return self.lat is not None and self.lon is not None


@dataclass
class Constraints:
    pin_boundaries: list[float] = field(default_factory=list)              # epoch seconds
    keep_together: list[frozenset[str]] = field(default_factory=list)       # asset id sets
    exclude: dict[str, set[str]] = field(default_factory=dict)              # event id -> asset ids
    include: dict[str, set[str]] = field(default_factory=dict)              # event id -> asset ids


@dataclass
class ExistingEvent:
    id: str
    start: float
    end: float
    asset_ids: frozenset[str]
    frozen: bool = False
    kind: str = "event"


# ----------------------------------------------------------------------------- outputs

@dataclass
class Membership:
    asset_id: str
    blob_id: str
    confidence: float
    tier: str                 # confirmed | probable | uncertain
    source: str = "auto"      # auto | manual


@dataclass
class Moment:
    start: float
    end: float
    blob_ids: list[str]
    label: str | None
    center: tuple[float, float] | None


@dataclass
class Boundary:
    """Explanation of one candidate cut between consecutive voting assets."""
    left_asset: str
    right_asset: str
    at: float                 # seconds: midpoint of the gap
    dt_min: float
    tau_min: float
    terms: dict[str, float]
    score: float
    cut: bool
    reason: str               # score | pinned | frozen | kept_together | merged_suggested


@dataclass
class EventOut:
    id: str
    is_new: bool
    kind: str                 # event | loose
    start: float
    end: float
    center: tuple[float, float] | None
    members: list[Membership]
    moments: list[Moment]
    suggested_splits: list[float]
    confidence: float
    participants: set[int]
    contributors: set[str]
    matched_existing: str | None = None

    @property
    def asset_ids(self) -> set[str]:
        return {m.asset_id for m in self.members}


@dataclass
class Result:
    events: list[EventOut]
    boundaries: list[Boundary]
    deleted_event_ids: list[str]


# ----------------------------------------------------------------------------- helpers

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _jaccard(a: Iterable, b: Iterable) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    return len(sa & sb) / len(sa | sb)


def _gps_array(items: Sequence[Item]) -> np.ndarray:
    pts = [(it.lat, it.lon) for it in items if it.has_gps]
    return np.asarray(pts, dtype=np.float64).reshape(-1, 2)


def _mean_pair_cos(a: np.ndarray, b: np.ndarray) -> float | None:
    if a.shape[0] == 0 or b.shape[0] == 0:
        return None
    return float((a @ b.T).mean())


def _within_cos(a: np.ndarray) -> float | None:
    n = a.shape[0]
    if n < 2:
        return None
    s = a @ a.T
    return float((s.sum() - np.trace(s)) / (n * (n - 1)))


def _embs(items: Sequence[Item]) -> np.ndarray:
    e = [it.emb for it in items if it.emb is not None]
    return np.stack(e) if e else np.zeros((0, 512), dtype=np.float32)


# ----------------------------------------------------------------------------- pass 1

def boundary_terms(left: Sequence[Item], right: Sequence[Item], *, dist_scale_m: float | None = None,
                   tau_fixed: float | None = None) -> tuple[dict[str, float], float, float]:
    """Compute the five §9.3 terms for windows L and R. Returns (terms, dt_min, tau_min)."""
    p = WBS
    a, b = left[-1], right[0]
    dt = (b.t - a.t) / 60.0

    # gap: adaptive tolerance from the local median gap
    if tau_fixed is not None:
        tau = tau_fixed
    else:
        ts = np.asarray([it.t for it in (*left, *right)])
        gaps = np.diff(ts) / 60.0
        gaps = gaps[gaps > 0]
        med = float(np.median(gaps)) if gaps.size else p["tau_min"]
        tau = float(np.clip(p["tau_median_multiplier"] * med, p["tau_min"], p["tau_max"]))
    gap = 1.0 if dt > p["hard_gap_minutes"] else _sigmoid((dt - tau) / (tau / 2.0))

    # distance between window GPS centroids
    gl, gr = _gps_array(left), _gps_array(right)
    if gl.shape[0] < 2 or gr.shape[0] < 2:
        dist, d = 0.5, None
    else:
        cl, cr = centroid(gl), centroid(gr)
        d = haversine_m(cl[0], cl[1], cr[0], cr[1])
        dist = 1.0 - math.exp(-d / (dist_scale_m or p["dist_scale_m"]))
        if dt > 0 and dt < p["travel_max_minutes"] and (d / 1000.0) / (dt / 60.0) < p["travel_max_kmh"]:
            dist *= 0.5

    # people
    pl = set().union(*(it.people for it in left)) if left else set()
    pr = set().union(*(it.people for it in right)) if right else set()
    people = 0.5 if (not pl or not pr) else 1.0 - _jaccard(pl, pr)

    # visual
    el, er = _embs(left), _embs(right)
    s_cross = _mean_pair_cos(el, er)
    wl, wr = _within_cos(el), _within_cos(er)
    within = [w for w in (wl, wr) if w is not None]
    if s_cross is None or not within:
        visual = 0.5
    else:
        visual = float(np.clip(0.5 + (float(np.mean(within)) - s_cross) * 2.0, 0.0, 1.0))

    # contributors
    contrib = 1.0 - _jaccard({it.contrib for it in left}, {it.contrib for it in right})

    return {"gap": gap, "dist": dist, "people": people, "visual": visual, "contrib": contrib, "d_m": d if d is not None else float("nan")}, dt, tau


def score_boundaries(voters: Sequence[Item], constraints: Constraints, frozen: Sequence[ExistingEvent]) -> list[Boundary]:
    p, w = WBS, WBS["weights"]
    W = p["window"]
    out: list[Boundary] = []
    kt_spans = [(min(v.t for v in voters if v.id in s), max(v.t for v in voters if v.id in s))
                for s in constraints.keep_together if any(v.id in s for v in voters)]
    for i in range(len(voters) - 1):
        L = voters[max(0, i - W + 1): i + 1]
        R = voters[i + 1: i + 1 + W]
        terms, dt, tau = boundary_terms(L, R)
        score = sum(w[k] * terms[k] for k in w)
        a, b = voters[i], voters[i + 1]
        at = (a.t + b.t) / 2.0
        cut = score >= p["cut_threshold"]
        reason = "score"
        # constraints and frozen events
        forbidden = any(lo <= a.t and b.t <= hi for lo, hi in kt_spans)
        for ev in frozen:
            if ev.start <= a.t and b.t <= ev.end:
                forbidden = True
            if a.t < ev.start <= b.t or a.t <= ev.end < b.t:
                cut, reason = True, "frozen"
        if forbidden and reason == "score":
            cut, reason = False, "kept_together"
        if any(a.t < tp <= b.t for tp in constraints.pin_boundaries):
            cut, reason = True, "pinned"
        out.append(Boundary(a.id, b.id, at, dt, tau, terms, score, cut, reason))
    return out


# ----------------------------------------------------------------------------- pass 2

@dataclass
class _Seg:
    items: list[Item]
    left_boundary: Boundary | None = None      # the cut that starts this segment
    contiguous: bool = True
    kind: str = "event"
    suggested_splits: list[float] = field(default_factory=list)
    uncertain_ids: set[str] = field(default_factory=set)

    @property
    def start(self) -> float:
        return self.items[0].t

    @property
    def end(self) -> float:
        return self.items[-1].t


def _split_at_cuts(voters: Sequence[Item], bounds: list[Boundary]) -> list[_Seg]:
    segs: list[_Seg] = []
    cur: list[Item] = [voters[0]] if voters else []
    left: Boundary | None = None
    for i, bd in enumerate(bounds):
        if bd.cut:
            segs.append(_Seg(cur, left))
            cur, left = [], bd
        cur.append(voters[i + 1])
    if cur:
        segs.append(_Seg(cur, left))
    return segs


def _overlong_cut(segs: list[_Seg], bounds_by_left: dict[str, Boundary]) -> list[_Seg]:
    max_s = WBS["max_event_hours"] * 3600.0
    out: list[_Seg] = []
    queue = list(segs)
    while queue:
        s = queue.pop(0)
        if not s.contiguous or s.end - s.start <= max_s or len(s.items) < 2:
            out.append(s)
            continue
        best_i, best = -1, -1.0
        for i in range(len(s.items) - 1):
            bd = bounds_by_left.get(s.items[i].id)
            if bd is None or bd.reason == "kept_together":
                continue
            if bd.score > best:
                best_i, best = i, bd.score
        if best_i < 0:
            out.append(s)
            continue
        bd = bounds_by_left[s.items[best_i].id]
        bd.cut, bd.reason = True, "overlong"
        a, b = _Seg(s.items[: best_i + 1], s.left_boundary), _Seg(s.items[best_i + 1:], bd)
        queue[:0] = [a, b]
    return out


def _concurrent_split(seg: _Seg) -> list[_Seg]:
    c = WBS["concurrent"]
    gps_items = [it for it in seg.items if it.has_gps]
    if len(gps_items) < c["min_gps_assets"]:
        return [seg]
    from sklearn.cluster import DBSCAN
    pts = _gps_array(gps_items)
    ref = centroid(pts)
    xy = to_local_xy(pts, ref)
    labels = DBSCAN(eps=c["eps_m"], min_samples=c["min_samples"]).fit_predict(xy)
    clusters: dict[int, list[Item]] = {}
    for it, lb in zip(gps_items, labels):
        if lb >= 0:
            clusters.setdefault(int(lb), []).append(it)
    spans = {k: (min(i.t for i in v), max(i.t for i in v)) for k, v in clusters.items()}
    good = [k for k, (s, e) in spans.items() if e - s >= c["min_span_minutes"] * 60]
    if len(good) < 2:
        return [seg]
    overlap = any(spans[a][0] <= spans[b][1] and spans[b][0] <= spans[a][1] for i, a in enumerate(good) for b in good[i + 1:])
    if not overlap:
        return [seg]
    # assign every item to a cluster
    member_of = {it.id: k for k, v in clusters.items() if k in good for it in v}
    largest = max(good, key=lambda k: len(clusters[k]))
    people_of = {k: set().union(*(i.people for i in clusters[k])) for k in good}
    uncertain: set[str] = set()
    for it in seg.items:
        if it.id in member_of:
            continue
        # same contributor's nearest-in-time GPS asset
        cands = [(abs(o.t - it.t), member_of[o.id]) for o in gps_items if o.contrib == it.contrib and o.id in member_of]
        if cands:
            member_of[it.id] = min(cands)[1]
            continue
        if it.people:
            best = max(good, key=lambda k: len(people_of[k] & it.people))
            if people_of[best] & it.people:
                member_of[it.id] = best
                continue
        member_of[it.id] = largest
        uncertain.add(it.id)
    out = []
    for k in good:
        items = sorted([it for it in seg.items if member_of[it.id] == k], key=lambda i: i.t)
        out.append(_Seg(items, seg.left_boundary, contiguous=False, uncertain_ids={i.id for i in items} & uncertain))
    return out


def _min_size(seg: _Seg) -> _Seg:
    if len(seg.items) < WBS["min_event_assets"] and (seg.end - seg.start) < WBS["min_event_minutes"] * 60:
        seg.kind = "loose"
    return seg


def _adjacent_merge(segs: list[_Seg]) -> list[_Seg]:
    lo, hi = WBS["adjacent_merge_band"]
    out: list[_Seg] = []
    for s in segs:
        if out and s.contiguous and out[-1].contiguous and s.kind == "event" and out[-1].kind == "event":
            prev, bd = out[-1], s.left_boundary
            if bd is not None and bd.reason in ("score",) and lo <= bd.score < hi:
                gp, gs = _gps_array(prev.items), _gps_array(s.items)
                if gp.shape[0] and gs.shape[0]:
                    cp, cs = centroid(gp), centroid(gs)
                    same_place = haversine_m(cp[0], cp[1], cs[0], cs[1]) <= WBS["same_place_m"]
                else:
                    same_place = gp.shape[0] == 0 and gs.shape[0] == 0
                pp = set().union(*(i.people for i in prev.items))
                ps = set().union(*(i.people for i in s.items))
                people_ok = _jaccard(pp, ps) >= 0.5 if (pp or ps) else True
                dt = (s.start - prev.end) / 60.0
                if same_place and people_ok and dt < 90:
                    bd.cut, bd.reason = False, "merged_suggested"
                    prev.items.extend(s.items)
                    prev.suggested_splits.append(bd.at)
                    prev.uncertain_ids |= s.uncertain_ids
                    continue
        out.append(s)
    return out


def _collapse_loose(segs: list[_Seg], tz_offset_s: float) -> list[_Seg]:
    """Adjacent loose segments on the same local day become one loose grouping."""
    out: list[_Seg] = []
    for s in segs:
        if s.kind == "loose" and out and out[-1].kind == "loose":
            d1 = math.floor((out[-1].end + tz_offset_s) / 86400)
            d2 = math.floor((s.start + tz_offset_s) / 86400)
            if d1 == d2:
                out[-1].items.extend(s.items)
                out[-1].contiguous = False
                continue
        out.append(s)
    return out


# ----------------------------------------------------------------------------- moments

def _clean_tag(tag: str) -> str:
    for prefix in ("a photo of a ", "a photo of ", "an ", "a "):
        if tag.startswith(prefix):
            tag = tag[len(prefix):]
            break
    return tag[:1].upper() + tag[1:]


def moments_for(items: Sequence[Item]) -> list[Moment]:
    m = WBS["moments"]
    items = sorted(items, key=lambda i: i.t)
    if not items:
        return []
    wts = {"gap": 0.45, "dist": 0.20, "visual": 0.10}
    tot = sum(wts.values())
    groups: list[list[Item]] = [[items[0]]]
    W = WBS["window"]
    for i in range(len(items) - 1):
        L, R = items[max(0, i - W + 1): i + 1], items[i + 1: i + 1 + W]
        terms, _, _ = boundary_terms(L, R, dist_scale_m=m["eps_m"], tau_fixed=m["tau_minutes"])
        score = sum(wts[k] * terms[k] for k in wts) / tot
        if score >= m["threshold"]:
            groups.append([])
        groups[-1].append(items[i + 1])
    out: list[Moment] = []
    for g in groups:
        label = None
        counts: dict[str, int] = {}
        for it in g:
            for tag, s in it.tags.items():
                if s >= m["tag_score"]:
                    counts[tag] = counts.get(tag, 0) + 1
        if counts:
            tag, n = max(counts.items(), key=lambda kv: kv[1])
            if n / len(g) >= m["tag_coverage"]:
                label = _clean_tag(tag)
        gps = _gps_array(g)
        out.append(Moment(g[0].t, g[-1].t, [it.blob_id for it in g], label, centroid(gps) if gps.shape[0] else None))
    return out


# ----------------------------------------------------------------------------- membership confidence

def participants_of(items: Sequence[Item]) -> set[int]:
    """People recognized in ≥ 2 assets (or ≥ 1 for tiny events): a face seen once is not yet a participant."""
    counts: dict[int, int] = {}
    for it in items:
        for pid in it.people:
            counts[pid] = counts.get(pid, 0) + 1
    need = 1 if len(items) <= 3 else 2
    return {pid for pid, n in counts.items() if n >= need}


def membership_confidence(items: Sequence[Item], center: tuple[float, float] | None, mean_emb: np.ndarray | None,
                          participants: set[int]) -> dict[str, float]:
    w = WBS["membership_weights"]
    items = sorted(items, key=lambda i: i.t)
    ts = np.asarray([i.t for i in items])
    contrib_n: dict[str, int] = {}
    for it in items:
        contrib_n[it.contrib] = contrib_n.get(it.contrib, 0) + 1
    out: dict[str, float] = {}
    for idx, it in enumerate(items):
        before = int(((ts >= it.t - 1800) & (ts < it.t)).sum())
        after = int(((ts <= it.t + 1800) & (ts > it.t)).sum())
        if idx == 0 or idx == len(items) - 1:
            interior = 0.0
        elif before >= 3 and after >= 3:
            interior = 1.0
        elif before >= 3 or after >= 3:
            interior = 0.5
        else:
            interior = 0.0
        if not it.has_gps or center is None:
            geo = 0.5
        else:
            d = haversine_m(it.lat, it.lon, center[0], center[1])
            geo = 1.0 if d <= 300 else 0.0 if d > 2000 else 1.0 - (d - 300) / 1700.0
        if it.people & participants:
            people = 1.0
        elif it.n_faces == 0 or not it.people:
            people = 0.5
        else:
            people = 0.0
        if it.emb is None or mean_emb is None:
            visual = 0.5
        else:
            visual = float(np.clip((float(it.emb @ mean_emb) - 0.5) / 0.4, 0.0, 1.0))
        n = contrib_n[it.contrib]
        support = 1.0 if n >= 5 else 0.5 if n >= 2 else 0.0
        out[it.id] = w["interior"] * interior + w["geo"] * geo + w["people"] * people + w["visual"] * visual + w["support"] * support
    return out


def tier_for(conf: float) -> str:
    t = WBS["tiers"]
    return "confirmed" if conf >= t["confirmed"] else "probable" if conf >= t["probable"] else "uncertain"


# ----------------------------------------------------------------------------- stable ids

def match_ids(segs: list[_Seg], existing: Sequence[ExistingEvent]) -> dict[int, ExistingEvent | None]:
    pairs = []
    for si, s in enumerate(segs):
        ids = {it.id for it in s.items}
        for ev in existing:
            j = _jaccard(ids, ev.asset_ids)
            if j >= WBS["id_reuse_jaccard"]:
                pairs.append((j, si, ev))
    pairs.sort(key=lambda p: -p[0])
    used_seg: set[int] = set()
    used_ev: set[str] = set()
    out: dict[int, ExistingEvent | None] = {i: None for i in range(len(segs))}
    for _, si, ev in pairs:
        if si in used_seg or ev.id in used_ev:
            continue
        out[si] = ev
        used_seg.add(si)
        used_ev.add(ev.id)
    return out


# ----------------------------------------------------------------------------- driver

def segment(items: Sequence[Item], constraints: Constraints | None = None, existing: Sequence[ExistingEvent] = (),
            tz_offset_s: float = 3600.0) -> Result:
    constraints = constraints or Constraints()
    items = sorted(items, key=lambda i: (i.t, i.id))
    if not items:
        return Result([], [], [ev.id for ev in existing])
    frozen = [ev for ev in existing if ev.frozen]
    voters = [it for it in items if not it.time_uncertain] or list(items)
    non_voters = [it for it in items if it.time_uncertain] if len(voters) < len(items) else []

    bounds = score_boundaries(voters, constraints, frozen)
    bounds_by_left = {b.left_asset: b for b in bounds}
    segs = _split_at_cuts(voters, bounds)
    segs = _overlong_cut(segs, bounds_by_left)
    segs = [s2 for s in segs for s2 in _concurrent_split(s)]
    segs.sort(key=lambda s: s.start)
    segs = [_min_size(s) for s in segs]
    segs = _adjacent_merge(segs)
    segs = _collapse_loose(segs, tz_offset_s)

    # place time-uncertain media: containing segment, else nearest within 2 h, else its own loose group
    for it in non_voters:
        best, best_d = None, float("inf")
        for s in segs:
            d = 0.0 if s.start <= it.t <= s.end else min(abs(it.t - s.start), abs(it.t - s.end))
            if d < best_d:
                best, best_d = s, d
        if best is not None and best_d <= 7200:
            best.items.append(it)
            best.items.sort(key=lambda i: i.t)
            best.uncertain_ids.add(it.id)
        else:
            segs.append(_Seg([it], None, contiguous=False, kind="loose", uncertain_ids={it.id}))
    segs.sort(key=lambda s: s.start)

    matched = match_ids(segs, existing)
    events: list[EventOut] = []
    for si, s in enumerate(segs):
        ev = matched[si]
        eid = ev.id if ev else str(uuid.uuid4())
        include = constraints.include.get(eid, set())
        exclude = constraints.exclude.get(eid, set())
        s_items = [it for it in s.items if it.id not in exclude]
        gps = _gps_array(s_items)
        center = centroid(gps) if gps.shape[0] else None
        embs = _embs(s_items)
        mean_emb = None
        if embs.shape[0]:
            mean_emb = embs.mean(axis=0)
            mean_emb = mean_emb / max(float(np.linalg.norm(mean_emb)), 1e-9)
        parts = participants_of(s_items)
        conf = membership_confidence(s_items, center, mean_emb, parts) if s.kind == "event" else {i.id: 0.5 for i in s_items}
        members = []
        for it in s_items:
            c = conf[it.id]
            if it.id in s.uncertain_ids:
                c = min(c, WBS["tiers"]["probable"] - 0.01)
            tier, source = tier_for(c), "auto"
            if it.id in include:
                tier, source, c = "confirmed", "manual", max(c, WBS["tiers"]["confirmed"])
            members.append(Membership(it.id, it.blob_id, round(c, 4), tier, source))
        if not members:
            continue
        n = len(members)
        weights = np.ones(n)
        edge = min(3, n)
        weights[:edge] = 2.0
        weights[-edge:] = 2.0
        conf_event = float(np.average([m.confidence for m in members], weights=weights)) - 0.1 * len(s.suggested_splits)
        events.append(EventOut(
            id=eid, is_new=ev is None, kind=s.kind,
            start=s_items[0].t, end=s_items[-1].t, center=center,
            members=members,
            moments=moments_for(s_items) if s.kind == "event" else [],
            suggested_splits=list(s.suggested_splits),
            confidence=round(max(0.0, min(1.0, conf_event)), 4),
            participants=parts,
            contributors={it.contrib for it in s_items},
            matched_existing=ev.id if ev else None,
        ))

    # include constraints for events that exist but did not surface: force the asset into that event id
    by_id = {e.id: e for e in events}
    item_by_id = {it.id: it for it in items}
    for eid, asset_ids in constraints.include.items():
        for aid in asset_ids:
            it = item_by_id.get(aid)
            if it is None:
                continue
            for e in events:
                if e.id != eid:
                    e.members = [m for m in e.members if m.asset_id != aid]
            if eid in by_id and all(m.asset_id != aid for m in by_id[eid].members):
                by_id[eid].members.append(Membership(aid, it.blob_id, WBS["tiers"]["confirmed"], "confirmed", "manual"))
    events = [e for e in events if e.members]
    for e in events:
        e.members.sort(key=lambda m: item_by_id[m.asset_id].t)
        e.start, e.end = item_by_id[e.members[0].asset_id].t, item_by_id[e.members[-1].asset_id].t

    reused = {e.matched_existing for e in events if e.matched_existing}
    deleted = [ev.id for ev in existing if ev.id not in reused]
    return Result(events, bounds, deleted)
