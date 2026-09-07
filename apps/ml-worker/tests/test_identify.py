import numpy as np

from minnegela_ml.matching import cap_tier, cluster_unknown, compute_prototypes, match_face

rng = np.random.default_rng(1234)


def unit(v):
    return (v / np.linalg.norm(v)).astype(np.float32)


def person_vec(seed):
    return unit(np.random.default_rng(seed).normal(size=512))


def near(base, cos):
    """A vector with approximately the given cosine to base."""
    noise = unit(rng.normal(size=512))
    noise = unit(noise - base * float(noise @ base))
    return unit(cos * base + np.sqrt(1 - cos**2) * noise)


EMMA, JONAS, SARA = person_vec(1), person_vec(2), person_vec(3)
PROTOS = {1: EMMA[None, :], 2: JONAS[None, :], 3: SARA[None, :]}


def test_high_when_score_and_margin_clear():
    c = match_face(near(EMMA, 0.7), PROTOS)
    assert c.person_id == 1 and c.tier == "high" and c.score > 0.62


def test_probable_and_low_bands():
    assert match_face(near(EMMA, 0.55), PROTOS).tier == "probable"
    assert match_face(near(EMMA, 0.45), PROTOS).tier == "low"
    c = match_face(near(EMMA, 0.30), PROTOS)
    assert c.tier is None and c.person_id is None


def test_margin_rule_demotes_ambiguous_faces():
    # siblings: two persons with very similar prototypes
    sib = near(EMMA, 0.97)
    protos = {1: EMMA[None, :], 9: sib[None, :]}
    f = near(EMMA, 0.7)
    c = match_face(f, protos)
    assert c.margin < 0.06
    assert c.tier == "low"


def test_quality_caps():
    assert cap_tier("high", ["profile"]) == "probable"
    assert cap_tier("high", ["too_small"]) == "low"
    assert cap_tier("probable", ["low_quality"]) == "probable"
    assert cap_tier(None, ["profile"]) is None
    c = match_face(near(EMMA, 0.7), PROTOS, quality_flags=["profile"])
    assert c.tier == "probable"


def test_rejections_and_context_boost():
    f = near(EMMA, 0.7)
    assert match_face(f, PROTOS, rejected={1}).person_id != 1
    # borderline face: 0.59 is below the 0.62 high threshold, context boost of 0.05 lifts it
    f2 = near(EMMA, 0.59)
    assert match_face(f2, PROTOS).tier == "probable"
    assert match_face(f2, PROTOS, context_persons={1}).tier == "high"


def test_prototypes_multi_and_normalized():
    faces = np.stack([near(EMMA, 0.8) for _ in range(30)] + [near(SARA, 0.8) for _ in range(30)])
    protos = compute_prototypes(faces)
    assert protos.shape == (8, 512)  # ceil(60/8)
    assert np.allclose(np.linalg.norm(protos, axis=1), 1.0, atol=1e-5)
    small = compute_prototypes(faces[:5])
    assert small.shape == (1, 512)
    assert compute_prototypes(np.zeros((0, 512), dtype=np.float32)).shape == (0, 512)


def test_unknown_clustering_groups_same_person():
    a = np.stack([near(EMMA, 0.85) for _ in range(6)])
    b = np.stack([near(JONAS, 0.85) for _ in range(5)])
    noise = np.stack([unit(rng.normal(size=512)) for _ in range(3)])
    groups = cluster_unknown(np.concatenate([a, b, noise]))
    assert sorted(len(g) for g in groups) == [5, 6]
    assert any(set(g) == set(range(6)) for g in groups)
