"""§18.4: withdrawing face consent removes prototypes, labels and person_id assignments for that member."""
import datetime as dt
import uuid

import numpy as np
import pytest

from minnegela_ml.jobs.identify import rebuild_prototypes


@pytest.fixture
def group(conn):
    tag = uuid.uuid4().hex[:8]
    with conn.transaction():
        users, persons = {}, {}
        for n in ("m", "e"):
            users[n] = conn.execute("insert into users (email, display_name) values (%s, %s) returning id", (f"{n}-{tag}@consent.test", n)).fetchone()["id"]
        gid = conn.execute("insert into groups (name, created_by) values (%s, %s) returning id", (f"consent-{tag}", users["m"])).fetchone()["id"]
        for n, uid in users.items():
            conn.execute("insert into group_members (group_id, user_id, role, consent_faces_at) values (%s, %s, 'member', %s)", (gid, uid, dt.datetime.now(dt.timezone.utc) if n == "m" else None))
            persons[n] = conn.execute("insert into persons (group_id, user_id, name) values (%s, %s, %s) returning id", (gid, uid, n)).fetchone()["id"]
        dev = conn.execute("insert into devices (user_id, platform, name) values (%s, 'cli', 'd') returning id", (users["m"],)).fetchone()["id"]
    yield {"id": gid, "users": users, "persons": persons, "device": dev}
    with conn.transaction():
        conn.execute("delete from groups where id = %s", (gid,))
        conn.execute("delete from users where id = any(%s::uuid[])", (list(users.values()),))


def test_withdrawn_consent_clears_identity(conn, group):
    gid, pe, pm = group["id"], group["persons"]["e"], group["persons"]["m"]
    emb = (np.random.default_rng(0).standard_normal(512)).astype(np.float32)
    emb /= np.linalg.norm(emb)
    with conn.transaction():
        bid = conn.execute("insert into blobs (group_id, mime, captured_at, derived_at) values (%s, 'image/jpeg', now(), now()) returning id", (gid,)).fetchone()["id"]
        aid = conn.execute(
            "insert into assets (group_id, blob_id, owner_user_id, device_id, local_id, local_created_at) values (%s, %s, %s, %s, 'x', now()) returning id",
            (gid, bid, group["users"]["m"], group["device"]),
        ).fetchone()["id"]
        for pid, tier in ((pe, "confirmed"), (pm, "confirmed")):
            fid = conn.execute(
                "insert into faces (group_id, blob_id, box, det_score, person_id, tier, match_source) values (%s, %s, '{\"x\":0,\"y\":0,\"w\":100,\"h\":100}', 0.9, %s, %s, 'label') returning id",
                (gid, bid, pid, tier),
            ).fetchone()["id"]
            conn.execute("insert into ml.face_embeddings (face_id, emb, model) values (%s, %s, 'test')", (fid, emb))
            conn.execute("insert into face_labels (face_id, person_id, verdict, by_user_id) values (%s, %s, 'confirm', %s)", (fid, pid, group["users"]["m"]))
            conn.execute("insert into ml.person_prototypes (person_id, idx, emb, n_faces) values (%s, 0, %s, 1)", (pid, emb))
    assert sorted(conn.execute("select person_ids from assets where id = %s", (aid,)).fetchone()["person_ids"]) == sorted([pe, pm])

    with conn.transaction():
        protos = rebuild_prototypes(conn, str(gid))

    # e never consented: everything identifying them is gone, the detection itself stays
    assert pe not in protos and pm in protos
    assert conn.execute("select count(*) from ml.person_prototypes where person_id = %s", (pe,)).fetchone()["count"] == 0
    assert conn.execute("select count(*) from face_labels where person_id = %s", (pe,)).fetchone()["count"] == 0
    faces = conn.execute("select person_id, tier from faces where blob_id = %s order by person_id nulls first", (bid,)).fetchall()
    assert [f["person_id"] for f in faces] == [None, pm]
    assert conn.execute("select person_ids from assets where id = %s", (aid,)).fetchone()["person_ids"] == [pm]
