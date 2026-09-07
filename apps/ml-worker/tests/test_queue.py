import uuid

from minnegela_ml import queue


def test_dedupe_merges_window_and_claim_locks(conn):
    gid = str(uuid.uuid4())
    key = f"recluster:{gid}"
    with conn.transaction():
        queue.enqueue(conn, "recluster", {"groupId": gid, "from": "2026-03-14T00:00:00+00:00", "to": "2026-03-15T00:00:00+00:00"})
        queue.enqueue(conn, "recluster", {"groupId": gid, "from": "2026-03-10T00:00:00+00:00", "to": "2026-03-12T00:00:00+00:00"})
    rows = conn.execute("select * from jobs where dedupe_key = %s and done_at is null", (key,)).fetchall()
    assert len(rows) == 1
    assert rows[0]["payload"]["from"] == "2026-03-10T00:00:00+00:00"
    assert rows[0]["payload"]["to"] == "2026-03-15T00:00:00+00:00"
    job_id = rows[0]["id"]
    with conn.transaction():
        claimed = queue.claim(conn, ["recluster"], "w1", 10)
    assert job_id in [j.id for j in claimed]
    with conn.transaction():
        again = queue.claim(conn, ["recluster"], "w2", 10)
    assert job_id not in [j.id for j in again]
    with conn.transaction():
        queue.fail(conn, job_id, RuntimeError("boom"))
    r = conn.execute("select * from jobs where id = %s", (job_id,)).fetchone()
    assert r["locked_by"] is None and r["done_at"] is None and "boom" in r["error"] and r["attempts"] == 1
    # parks after max_attempts
    with conn.transaction():
        conn.execute("update jobs set attempts = max_attempts, run_after = now() where id = %s", (job_id,))
        queue.fail(conn, job_id, "again")
    r = conn.execute("select * from jobs where id = %s", (job_id,)).fetchone()
    assert r["done_at"] is not None and r["error"] == "again"
    with conn.transaction():
        conn.execute("delete from jobs where id = %s", (job_id,))


def test_release_stale(conn):
    gid = str(uuid.uuid4())
    with conn.transaction():
        queue.enqueue(conn, "analyze", {"groupId": gid, "blobId": str(uuid.uuid4())})
        jobs = queue.claim(conn, ["analyze"], "dead-worker", 100)
        mine = [j for j in jobs if j.payload["groupId"] == gid]
        assert len(mine) == 1
        conn.execute("update jobs set locked_at = now() - interval '2 hours' where id = %s", (mine[0].id,))
        # put back the others we accidentally claimed
        for j in jobs:
            if j.id != mine[0].id:
                conn.execute("update jobs set locked_by = null, locked_at = null, attempts = attempts - 1 where id = %s", (j.id,))
        assert queue.release_stale(conn, 30) >= 1
        r = conn.execute("select locked_by from jobs where id = %s", (mine[0].id,)).fetchone()
        assert r["locked_by"] is None
        conn.execute("delete from jobs where id = %s", (mine[0].id,))
