"""`identify` job: prototypes, matching with margin/context/quality rules, unknown-face clustering (DESIGN §5.3-5.6)."""
from __future__ import annotations

import logging
from collections import defaultdict

import numpy as np

from minnegela_ml.db import vec

from .. import db
from ..constants import FACE_MATCH
from ..matching import TIER_RANK, cluster_unknown, compute_prototypes, match_face

log = logging.getLogger(__name__)


def _eligible_persons(conn, group_id: str) -> dict[int, dict]:
    """Persons that may carry prototypes: non-members, or members with face consent (§18.4)."""
    rows = conn.execute(
        """
        select p.id, p.user_id, gm.consent_faces_at
        from persons p left join group_members gm on gm.group_id = p.group_id and gm.user_id = p.user_id
        where p.group_id = %s and p.hidden = false
        """,
        (group_id,),
    ).fetchall()
    return {r["id"]: r for r in rows if r["user_id"] is None or r["consent_faces_at"] is not None}


def rebuild_prototypes(conn, group_id: str, person_ids: list[int] | None = None) -> dict[int, np.ndarray]:
    eligible = _eligible_persons(conn, group_id)
    targets = list(eligible) if person_ids is None else [p for p in person_ids if p in eligible]
    # Persons that lost eligibility (a member withdrew face consent, §18.4): drop prototypes, labels and
    # every person_id assignment. Detections stay as anonymous boxes; the triggers shrink person_ids arrays.
    ineligible = [
        r["id"]
        for r in conn.execute("select id from persons where group_id = %s and not (id = any(%s::int[]))", (group_id, list(eligible) or [-1])).fetchall()
    ]
    if ineligible:
        conn.execute("delete from ml.person_prototypes where person_id = any(%s::int[])", (ineligible,))
        conn.execute("delete from face_labels where person_id = any(%s::int[])", (ineligible,))
        conn.execute(
            "update faces set person_id = null, tier = null, match_score = null, match_source = null where group_id = %s and person_id = any(%s::int[])",
            (group_id, ineligible),
        )
    out: dict[int, np.ndarray] = {}
    for pid in targets:
        rows = conn.execute(
            """
            select e.emb from faces f join ml.face_embeddings e on e.face_id = f.id
            where f.group_id = %s and (
              exists (select 1 from face_labels l where l.face_id = f.id and l.person_id = %s and l.verdict = 'confirm')
              or (f.person_id = %s and f.tier = 'confirmed'))
            and not exists (select 1 from face_labels l where l.face_id = f.id and l.person_id = %s and l.verdict = 'reject')
            """,
            (group_id, pid, pid, pid),
        ).fetchall()
        embs = np.stack([vec(r["emb"]) for r in rows]) if rows else np.zeros((0, 512), dtype=np.float32)
        protos = compute_prototypes(embs)
        conn.execute("delete from ml.person_prototypes where person_id = %s", (pid,))
        for i, p in enumerate(protos):
            conn.execute("insert into ml.person_prototypes (person_id, idx, emb, n_faces) values (%s, %s, %s, %s)", (pid, i, p, embs.shape[0]))
        if protos.shape[0]:
            out[pid] = protos
    return out


def load_prototypes(conn, group_id: str) -> dict[int, np.ndarray]:
    rows = conn.execute(
        "select pp.person_id, pp.emb from ml.person_prototypes pp join persons p on p.id = pp.person_id where p.group_id = %s and p.hidden = false order by pp.person_id, pp.idx",
        (group_id,),
    ).fetchall()
    by: dict[int, list] = defaultdict(list)
    for r in rows:
        by[r["person_id"]].append(vec(r["emb"]))
    return {pid: np.stack(v) for pid, v in by.items()}


def _context_persons(conn, blob_ids: list[str]) -> dict[str, set[int]]:
    """Persons with ≥ 3 confirmed/high faces on *other* blobs of an event the blob belongs to (§5.4 context boost)."""
    if not blob_ids:
        return {}
    ev_of_blob: dict[str, set[str]] = defaultdict(set)
    for r in conn.execute("select event_id, blob_id from event_assets where blob_id = any(%s::uuid[])", (blob_ids,)):
        ev_of_blob[str(r["blob_id"])].add(str(r["event_id"]))
    event_ids = sorted({e for s in ev_of_blob.values() for e in s})
    if not event_ids:
        return {}
    blobs_of: dict[tuple[str, int], set[str]] = defaultdict(set)
    for r in conn.execute(
        "select ea.event_id, f.person_id, f.blob_id from event_assets ea join faces f on f.blob_id = ea.blob_id "
        "where ea.event_id = any(%s::uuid[]) and f.person_id is not null and f.tier in ('confirmed','high')",
        (event_ids,),
    ):
        blobs_of[(str(r["event_id"]), r["person_id"])].add(str(r["blob_id"]))
    out: dict[str, set[int]] = {}
    need = FACE_MATCH["context_boost_min_confirmed"]
    for blob, evs in ev_of_blob.items():
        s: set[int] = set()
        for (ev, pid), blobs in blobs_of.items():
            if ev in evs and len(blobs - {blob}) >= need:
                s.add(pid)
        if s:
            out[blob] = s
    return out


def match_scope(conn, group_id: str, prototypes: dict[int, np.ndarray], blob_id: str | None) -> int:
    """(Re)match faces; returns the number of faces whose assignment changed."""
    where = "f.group_id = %s and (f.match_source is distinct from 'label')"
    params: list = [group_id]
    if blob_id:
        where += " and f.blob_id = %s"
        params.append(blob_id)
    faces = conn.execute(
        f"select f.id, f.blob_id, f.person_id, f.tier, f.quality_flags, e.emb from faces f join ml.face_embeddings e on e.face_id = f.id where {where}",
        params,
    ).fetchall()
    if not faces:
        return 0
    face_ids = [str(f["id"]) for f in faces]
    labels: dict[str, dict[str, set[int]]] = defaultdict(lambda: {"confirm": set(), "reject": set()})
    for r in conn.execute("select face_id, person_id, verdict from face_labels where face_id = any(%s::uuid[])", (face_ids,)):
        labels[str(r["face_id"])][r["verdict"]].add(r["person_id"])
    context = _context_persons(conn, sorted({str(f["blob_id"]) for f in faces}))
    changed = 0
    for f in faces:
        fid = str(f["id"])
        lab = labels.get(fid)
        if lab and lab["confirm"]:
            pid = sorted(lab["confirm"])[0]
            new = (pid, "confirmed", "label", None)
        else:
            cand = match_face(vec(f["emb"]), prototypes,
                              rejected=lab["reject"] if lab else set(),
                              context_persons=context.get(str(f["blob_id"]), set()),
                              quality_flags=list(f["quality_flags"] or []))
            src = None if cand.person_id is None else ("context" if cand.person_id in context.get(str(f["blob_id"]), set()) else "auto")
            new = (cand.person_id, cand.tier, src, round(cand.score, 4))
        if (f["person_id"], f["tier"]) != (new[0], new[1]):
            conn.execute("update faces set person_id = %s, tier = %s, match_source = %s, match_score = %s where id = %s",
                         (new[0], new[1], new[2], new[3], fid))
            changed += 1
    return changed


def cluster_unknown_faces(conn, group_id: str) -> int:
    setting = conn.execute("select coalesce((settings->>'cluster_unknown_faces')::boolean, true) as on from groups where id = %s", (group_id,)).fetchone()
    if not setting or not setting["on"]:
        conn.execute("delete from unknown_clusters where group_id = %s", (group_id,))
        return 0
    rows = conn.execute(
        """
        select f.id, e.emb from faces f
        join ml.face_embeddings e on e.face_id = f.id
        join blobs b on b.id = f.blob_id
        where f.group_id = %s and f.person_id is null
          and not (f.quality_flags && array['too_small','low_confidence']::text[])
          and not exists (
            select 1 from assets a join group_members gm on gm.user_id = a.owner_user_id and gm.group_id = a.group_id
            where a.blob_id = f.blob_id and gm.consent_faces_at is null)
        """,
        (group_id,),
    ).fetchall()
    ids = [str(r["id"]) for r in rows]
    embs = np.stack([vec(r["emb"]) for r in rows]) if rows else np.zeros((0, 512), dtype=np.float32)
    groups = cluster_unknown(embs)
    existing = conn.execute("select id, face_ids, dismissed from unknown_clusters where group_id = %s", (group_id,)).fetchall()
    kept: set[str] = set()
    for g in groups:
        fids = [ids[i] for i in g]
        cen = embs[g].mean(axis=0)
        cen = cen / max(float(np.linalg.norm(cen)), 1e-9)
        best, best_j = None, 0.0
        for ex in existing:
            if str(ex["id"]) in kept:
                continue
            exs = {str(x) for x in ex["face_ids"]}
            j = len(exs & set(fids)) / len(exs | set(fids))
            if j > best_j:
                best, best_j = ex, j
        if best is not None and best_j >= 0.5:
            cid = str(best["id"])
            conn.execute("update unknown_clusters set face_ids = %s::uuid[], n = %s, cover_face_id = %s where id = %s", (fids, len(fids), fids[0], cid))
        else:
            cid = conn.execute(
                "insert into unknown_clusters (group_id, face_ids, cover_face_id, n) values (%s, %s::uuid[], %s, %s) returning id",
                (group_id, fids, fids[0], len(fids)),
            ).fetchone()["id"]
            cid = str(cid)
        kept.add(cid)
        conn.execute(
            "insert into ml.unknown_cluster_centroids (cluster_id, centroid) values (%s, %s) on conflict (cluster_id) do update set centroid = excluded.centroid",
            (cid, cen.astype(np.float32)),
        )
    stale = [str(ex["id"]) for ex in existing if str(ex["id"]) not in kept]
    if stale:
        conn.execute("delete from unknown_clusters where id = any(%s::uuid[])", (stale,))
    return len(groups)


def run_identify(payload: dict) -> dict:
    group_id = payload["groupId"]
    blob_id = payload.get("blobId")
    person_id = payload.get("personId")
    with db.connect() as conn, conn.transaction():
        if blob_id:
            protos = load_prototypes(conn, group_id)
            if not protos:
                protos = rebuild_prototypes(conn, group_id)
            changed = match_scope(conn, group_id, protos, blob_id)
            return {"scope": "blob", "changed": changed}
        if person_id:
            rebuild_prototypes(conn, group_id, [int(person_id)])
        else:
            rebuild_prototypes(conn, group_id)
        protos = load_prototypes(conn, group_id)
        changed = match_scope(conn, group_id, protos, None)
        clusters = cluster_unknown_faces(conn, group_id)
        return {"scope": "person" if person_id else "group", "changed": changed, "unknown_clusters": clusters}
