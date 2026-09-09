"""Tag vocabulary integrity and calibration math (no models, no DB)."""
import numpy as np

from minnegela_ml import vocab
from minnegela_ml.calibrate import STATS_MIN_N, TagStats, robust_stats, score_from_z, tag_result, zscores
from minnegela_ml.vocab import CAT_OF, INDEX, KEYS, TAG_PRESENT, UTILITY_KEYS

rng = np.random.default_rng(7)
N = len(KEYS)


def test_vocab_is_consistent():
    vocab.check()
    assert "frisbee golf" in INDEX and CAT_OF["beer"] == "drink"
    assert set(UTILITY_KEYS) >= {"screenshot", "receipt", "document"}
    assert all(k == k.lower() and k.strip() == k for k in KEYS)


def library(n=200):
    """Synthetic raw cosine matrix: every tag has its own baseline; 'screenshot' and 'meme' sit high on everything
    (the attractor effect), 'frisbee golf' is low except on 10 frisbee images where it rises modestly."""
    base = rng.uniform(0.15, 0.20, size=N)
    base[INDEX["screenshot"]] = 0.215
    base[INDEX["meme"]] = 0.21
    base[INDEX["frisbee golf"]] = 0.16
    raw = base + rng.normal(0, 0.006, size=(n, N))
    raw[:10, INDEX["frisbee golf"]] += 0.05           # 0.21: still *below* screenshot's baseline
    return raw.astype(np.float32)


def test_calibration_defeats_attractor_prompts():
    raw = library()
    stats = robust_stats(raw)
    assert stats.usable() and stats.n == 200
    frisbee = tag_result(raw[0], stats)
    assert frisbee.tags[0]["tag"] == "frisbee golf" and frisbee.tags[0]["score"] >= TAG_PRESENT
    assert not frisbee.utility
    plain = tag_result(raw[50], stats)
    top3 = [t["tag"] for t in plain.tags[:3]]
    assert "screenshot" not in top3 and "meme" not in top3 and "frisbee golf" not in top3, plain.tags[:3]
    assert not plain.utility


def test_raw_ranking_would_have_been_wrong():
    raw = library()
    assert KEYS[int(np.argmax(raw[0]))] in ("screenshot", "meme")   # the bug this module exists for


def test_robust_centre_survives_a_common_tag():
    raw = library()
    # 40 % of the library is the same studio: the tag is common but its centre stays in the 'absent' mode
    raw[:80, INDEX["recording"]] += 0.06
    stats = robust_stats(raw)
    z_present = zscores(raw[0], stats)[INDEX["recording"]]
    z_absent = zscores(raw[150], stats)[INDEX["recording"]]
    assert z_present > 2.5, z_present          # score >= 0.6: still "present"
    assert abs(z_absent) < 2.5, z_absent


def test_fallback_without_stats_is_per_image():
    raw = library()
    z = zscores(raw[50], None)
    assert abs(float(z.mean())) < 1e-4 and abs(float(z.std()) - 1) < 1e-3
    # per-image normalisation cannot remove a per-prompt bias; that is what the group statistics are for
    assert KEYS[int(np.argmax(z))] == "screenshot"


def test_utility_rule_needs_raw_anchor():
    raw = library()
    stats = robust_stats(raw)
    shot = raw[20].copy()
    shot[INDEX["screenshot"]] += 0.08
    shot[INDEX["camera photo"]] = 0.10
    assert tag_result(shot, stats).utility
    party = raw[21].copy()
    party[INDEX["screenshot"]] += 0.08                # looks graphic...
    party[INDEX["camera photo"]] = 0.40               # ...but is clearly a real photo
    assert not tag_result(party, stats).utility


def test_score_shape_and_stats_gate():
    assert score_from_z(np.asarray([2.25]))[0] == 0.5
    assert 0.59 < score_from_z(np.asarray([2.5]))[0] < 0.61
    assert not TagStats(np.zeros(N), np.ones(N), n=STATS_MIN_N - 1).usable()
    assert TagStats(np.zeros(N), np.ones(N), n=STATS_MIN_N).usable()


def test_quality_anchors_never_surface():
    raw = library()
    raw[0, INDEX["beautiful photo"]] = 0.9
    res = tag_result(raw[0], robust_stats(raw))
    assert "beautiful photo" not in [t["tag"] for t in res.tags]
    assert res.aesthetic > 0.5
