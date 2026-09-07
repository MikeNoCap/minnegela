"""End-to-end recluster against the real schema: rows in, events out, triggers maintain arrays, ids stable."""
import datetime as dt
import uuid

import pytest

from minnegela_ml.jobs.recluster import run_recluster, tz_for

OSLO = (59.9227, 10.7575)


@pytest.fixture
def group(conn):
    tag = uuid.uuid4().hex[:8]
    with conn.transaction():
        users = {}
        for n in ("m", "e"):
            users[n] = conn.execute("insert into users (email, display_name) values (%s, %s) returning id", (f"{n}-{tag}@recluster.test", n)).fetchone()["id"]
        gid = conn.execute("insert into groups (name, created_by) values (%s, %s) returning id", (f"recluster-{tag}", users["m"])).fetchone()["id"]
        devs = {}
        for n, uid in users.items():
            conn.execute("insert into group_members (group_id, user_id, role) values (%s, %s, 'member')", (gid, uid))
            devs[n] = conn.execute("insert into devices (user_id, platform, name) values (%s, 'cli', %s) returning id", (uid, n)).fetchone()["id"]
    yield {"id": gid, "users": users, "devices": devs}
    with conn.transaction():
        conn.execute("delete from jobs where payload->>'groupId' = %s", (str(gid),))
        conn.execute("delete from groups where id = %s", (gid,))
        conn.execute("delete from users where id = any(%s::uuid[])", (list(users.values()),))


def add(conn, g, owner, when: dt.datetime, n: int, loc=OSLO, step_min=5):
    ids = []
    with conn.transaction():
        for i in range(n):
            t = when + dt.timedelta(minutes=i * step_min)
            bid = conn.execute(
                "insert into blobs (group_id, mime, captured_at, lat, lon, derived_at) values (%s, 'image/jpeg', %s, %s, %s, now()) returning id",
                (g["id"], t, loc[0], loc[1]),
            ).fetchone()["id"]
            aid = conn.execute(
                "insert into assets (group_id, blob_id, owner_user_id, device_id, local_id, local_created_at) values (%s, %s, %s, %s, %s, %s) returning id",
                (g["id"], bid, g["users"][owner], g["devices"][owner], f"{owner}-{uuid.uuid4().hex[:6]}", t),
            ).fetchone()["id"]
            ids.append(str(aid))
    return ids


def test_full_and_incremental_recluster(conn, group):
    night = dt.datetime(2026, 3, 14, 21, 0, tzinfo=dt.timezone.utc)
    a = add(conn, group, "m", night, 12) + add(conn, group, "e", night + dt.timedelta(minutes=2), 10)
    b = add(conn, group, "m", night + dt.timedelta(hours=14), 6, loc=(59.93, 10.79))
    s = run_recluster({"groupId": str(group["id"]), "full": True})
    assert s["events"] == 2 and s["deleted"] == 0
    evs = conn.execute("select * from events where group_id = %s and deleted_at is null order by start_at", (group["id"],)).fetchall()
    assert len(evs) == 2
    party, breakfast = evs
    assert party["n_assets"] == 22 and breakfast["n_assets"] == 6
    assert set(map(str, party["contributor_ids"])) == {str(group["users"]["m"]), str(group["users"]["e"])}
    assert party["tz"] == "Europe/Oslo"
    members = conn.execute("select asset_id, tier from event_assets where event_id = %s", (party["id"],)).fetchall()
    assert {str(r["asset_id"]) for r in members} == set(a)
    assert conn.execute("select count(*) as n from moments where event_id = %s", (party["id"],)).fetchone()["n"] >= 1
    titles = conn.execute("select payload from jobs where kind = 'titles' and payload->>'groupId' = %s", (str(group["id"]),)).fetchall()
    assert titles and str(party["id"]) in titles[-1]["payload"]["eventIds"]

    # incremental: a late upload from e inside the party window keeps ids
    late = add(conn, group, "e", night + dt.timedelta(minutes=30), 5)
    s2 = run_recluster({"groupId": str(group["id"]), "from": (night + dt.timedelta(minutes=30)).isoformat(), "to": (night + dt.timedelta(minutes=55)).isoformat()})
    assert s2["reused_ids"] >= 1 and s2["deleted"] == 0
    evs2 = conn.execute("select id, n_assets from events where group_id = %s and deleted_at is null order by start_at", (group["id"],)).fetchall()
    assert [str(e["id"]) for e in evs2] == [str(party["id"]), str(breakfast["id"])]
    assert evs2[0]["n_assets"] == 27

    # constraints: pin a boundary inside the party → two events, the old id survives on the larger half
    with conn.transaction():
        conn.execute("insert into event_constraints (group_id, kind, at, by_user_id) values (%s, 'pin_boundary', %s, %s)",
                     (group["id"], night + dt.timedelta(minutes=31), group["users"]["m"]))
    run_recluster({"groupId": str(group["id"]), "full": True})
    evs3 = conn.execute("select id, n_assets from events where group_id = %s and deleted_at is null order by start_at", (group["id"],)).fetchall()
    assert len(evs3) == 3
    assert str(party["id"]) in {str(e["id"]) for e in evs3}


def test_tz_lookup():
    assert tz_for(OSLO) == "Europe/Oslo"
    assert tz_for((51.5, -0.1)) == "Europe/London"
    assert tz_for((40.7, -74.0)) == "America/New_York"
    assert tz_for(None) == "Europe/Oslo"
