"""Synthetic timelines for WBS tests."""
from __future__ import annotations

import datetime as dt

import numpy as np

from minnegela_ml.wbs import Item

OSLO = (59.9227, 10.7575)
CABIN = (61.1, 9.2)          # ~150 km away
BREAKFAST = (59.9300, 10.7900)  # ~2 km away

_rng = np.random.default_rng(7)
_scenes: dict[str, np.ndarray] = {}


def scene_emb(scene: str, noise: float = 0.35) -> np.ndarray:
    if scene not in _scenes:
        _scenes[scene] = _rng.normal(size=512)
    v = _scenes[scene] + noise * _rng.normal(size=512) * np.linalg.norm(_scenes[scene]) / np.sqrt(512)
    return (v / np.linalg.norm(v)).astype(np.float32)


def ts(day: str, hhmm: str) -> float:
    return dt.datetime.fromisoformat(f"{day}T{hhmm}:00+01:00").timestamp()


def make(prefix: str, t: float, contrib: str, loc=None, people=(), scene="party", n_faces=None, **kw) -> Item:
    people = frozenset(people)
    return Item(
        id=f"{prefix}", blob_id=f"b-{prefix}", t=t, contrib=contrib,
        lat=None if loc is None else loc[0] + _rng.normal(0, 0.0002),
        lon=None if loc is None else loc[1] + _rng.normal(0, 0.0004),
        people=people, emb=scene_emb(scene), n_faces=len(people) if n_faces is None else n_faces, **kw,
    )


def party(day: str = "2026-03-14", contribs=("m", "e", "j", "s")) -> list[Item]:
    """§9.3 worked example: 21:30–23:14 dense, 48-min gap, street photo 00:02 40 m away, then dense until 03:12."""
    items: list[Item] = []
    t = ts(day, "21:30")
    end1 = ts(day, "23:14")
    i = 0
    people_sets = [(1, 2), (2, 3), (1, 3), (1, 2, 3), (2,), ()]
    while t <= end1:
        c = contribs[i % len(contribs)]
        ppl = people_sets[i % len(people_sets)]
        items.append(make(f"p{i}", t, c, OSLO, ppl, "party"))
        t += 4 * 60 + (i % 3) * 60
        i += 1
    # 23:47 table photo: no faces
    items.append(make("table", ts(day, "23:47"), "m", OSLO, (), "party"))
    # street outside at 00:02, 40 m away
    day2 = (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()
    items.append(make("street", ts(day2, "00:02"), "j", (OSLO[0] + 0.00036, OSLO[1]), (1, 3), "street"))
    t = ts(day2, "00:05")
    end2 = ts(day2, "03:12")
    while t <= end2:
        c = contribs[i % len(contribs)]
        ppl = people_sets[i % len(people_sets)]
        items.append(make(f"p{i}", t, c, OSLO, ppl, "party"))
        t += 4 * 60 + (i % 3) * 60
        i += 1
    return items


def breakfast(day: str = "2026-03-15") -> list[Item]:
    return [make(f"bf{i}", ts(day, "10:40") + i * 180, "m" if i % 2 else "e", BREAKFAST, (1, 2), "breakfast") for i in range(6)]
