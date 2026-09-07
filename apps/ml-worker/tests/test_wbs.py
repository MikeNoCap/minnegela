import numpy as np

from minnegela_ml.wbs import Constraints, ExistingEvent, Item, segment, moments_for
from synth import OSLO, CABIN, breakfast, make, party, ts


def ids(ev):
    return {m.asset_id for m in ev.members}


def test_party_is_one_event_and_breakfast_is_cut():
    items = party() + breakfast()
    res = segment(items)
    events = [e for e in res.events if e.kind == "event"]
    assert len(events) == 2, [(e.kind, len(e.members)) for e in res.events]
    p, b = sorted(events, key=lambda e: e.start)
    party_ids = {i.id for i in party()}
    assert ids(p) == party_ids
    assert ids(b) == {i.id for i in breakfast()}
    # the 48-minute gap + street photo did not cut
    street = next(bd for bd in res.boundaries if bd.right_asset == "street")
    assert not street.cut and street.score < 0.5, street
    # the overnight gap did
    overnight = next(bd for bd in res.boundaries if bd.right_asset == "bf0")
    assert overnight.cut and overnight.terms["gap"] == 1.0


def test_faceless_table_photo_lands_inside_with_a_real_tier():
    res = segment(party())
    ev = next(e for e in res.events if e.kind == "event")
    table = next(m for m in ev.members if m.asset_id == "table")
    assert table.tier in ("confirmed", "probable")
    assert table.confidence >= 0.6
    assert ev.confidence >= 0.75
    assert ev.participants == {1, 2, 3}
    assert ev.contributors == {"m", "e", "j", "s"}
    assert ev.center is not None and abs(ev.center[0] - OSLO[0]) < 0.01


def test_concurrent_activity_splits_by_space():
    items = []
    t0 = ts("2026-07-04", "12:00")
    for i in range(14):
        items.append(make(f"o{i}", t0 + i * 15 * 60, ["m", "e", "s"][i % 3], OSLO, (1, 2), "oslo"))
        items.append(make(f"c{i}", t0 + i * 15 * 60 + 200, "j", CABIN, (3,), "cabin"))
    res = segment(items)
    events = [e for e in res.events if e.kind == "event"]
    assert len(events) == 2
    got = {frozenset(ids(e)) for e in events}
    assert got == {frozenset(f"c{i}" for i in range(14)), frozenset(f"o{i}" for i in range(14))}


def test_overlong_segment_is_cut_to_under_18_hours():
    t0 = ts("2026-06-20", "08:00")
    items = [make(f"f{i}", t0 + i * 20 * 60, "m", OSLO, (1,), "festival") for i in range(90)]  # 30 h
    res = segment(items)
    assert sum(len(e.members) for e in res.events) == 90
    for e in res.events:
        assert e.end - e.start <= 18 * 3600
    assert len([e for e in res.events if e.kind == "event"]) >= 2


def test_keep_together_and_pin_boundary():
    items = party() + breakfast()
    together = frozenset(i.id for i in items)
    res = segment(items, Constraints(keep_together=[together]))
    assert len([e for e in res.events if e.kind == "event"]) == 1
    pin = ts("2026-03-14", "22:30")
    res = segment(party(), Constraints(pin_boundaries=[pin]))
    events = sorted([e for e in res.events if e.kind == "event"], key=lambda e: e.start)
    assert len(events) == 2
    assert events[0].end < pin <= events[1].start
    assert any(b.reason == "pinned" and b.cut for b in res.boundaries)


def test_incremental_run_keeps_event_ids():
    first = segment(party() + breakfast())
    existing = [ExistingEvent(e.id, e.start, e.end, frozenset(ids(e))) for e in first.events]
    # a fifth contributor uploads 10 photos of the party a year later
    late = [make(f"late{i}", ts("2026-03-14", "22:00") + i * 600, "k", OSLO, (1, 4), "party") for i in range(10)]
    second = segment(party() + breakfast() + late, existing=existing)
    old_ids = {e.id for e in first.events}
    new_ids = {e.id for e in second.events}
    assert old_ids == new_ids
    assert all(not e.is_new for e in second.events)
    assert second.deleted_event_ids == []
    p = max(second.events, key=lambda e: len(e.members))
    assert {f"late{i}" for i in range(10)} <= ids(p)
    assert "k" in p.contributors


def test_exclude_and_include_constraints():
    first = segment(party() + breakfast())
    p = max(first.events, key=lambda e: len(e.members))
    b = min(first.events, key=lambda e: len(e.members))
    existing = [ExistingEvent(e.id, e.start, e.end, frozenset(ids(e))) for e in first.events]
    c = Constraints(exclude={p.id: {"table"}}, include={b.id: {"street"}})
    second = segment(party() + breakfast(), c, existing)
    p2 = next(e for e in second.events if e.id == p.id)
    b2 = next(e for e in second.events if e.id == b.id)
    assert "table" not in ids(p2)
    street = next(m for m in b2.members if m.asset_id == "street")
    assert street.tier == "confirmed" and street.source == "manual"
    assert "street" not in ids(p2)


def test_frozen_event_keeps_boundaries():
    items = party() + breakfast()
    first = segment(items)
    p = max(first.events, key=lambda e: len(e.members))
    frozen = ExistingEvent(p.id, p.start, p.end, frozenset(ids(p)), frozen=True)
    # remove the overnight gap: breakfast starts right after the party; without the frozen event they'd merge
    shifted = [Item(**{**i.__dict__, "t": i.t - (ts("2026-03-15", "10:40") - ts("2026-03-15", "03:20"))}) for i in breakfast()]
    res = segment(party() + shifted, existing=[frozen])
    p2 = next(e for e in res.events if e.id == p.id)
    assert ids(p2) == ids(p)
    assert any(b.reason == "frozen" and b.cut for b in res.boundaries)


def test_time_uncertain_media_is_placed_but_does_not_vote():
    items = party()
    received = make("recv", ts("2026-03-14", "22:10"), "e", None, (), "meme", time_uncertain=True)
    res = segment(items + [received])
    ev = next(e for e in res.events if e.kind == "event")
    m = next(m for m in ev.members if m.asset_id == "recv")
    assert m.tier == "uncertain"
    assert not any("recv" in (b.left_asset, b.right_asset) for b in res.boundaries)


def test_loose_singletons_collapse_per_day():
    t0 = ts("2026-05-01", "09:00")
    items = [make(f"s{i}", t0 + i * 5 * 3600, "m", None, (), f"scene{i}") for i in range(3)]  # three photos 5 h apart
    res = segment(items)
    assert all(e.kind == "loose" for e in res.events)
    assert len(res.events) == 1  # same local day → one loose group
    assert sum(len(e.members) for e in res.events) == 3


def test_moments_split_on_scene_and_label_from_tags():
    t0 = ts("2026-03-14", "20:00")
    dinner = [make(f"d{i}", t0 + i * 120, "m", OSLO, (1, 2), "dinner", tags={"a restaurant": 0.7}) for i in range(8)]
    out = [make(f"o{i}", t0 + 8 * 120 + 40 * 60 + i * 120, "m", (OSLO[0] + 0.005, OSLO[1]), (1, 2), "street", tags={"a city street at night": 0.65}) for i in range(8)]
    ms = moments_for(dinner + out)
    assert len(ms) == 2
    assert [m.label for m in ms] == ["Restaurant", "City street at night"]
