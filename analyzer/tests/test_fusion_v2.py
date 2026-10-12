"""Fusion v2 on synthetic streams: all five signals, the agreement bonus
(distinct signal groups only), per-category minimum durations, injected
weights / thresholds, and assemble_signals (stage arrays -> signals)."""

from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support  # noqa: E402, F401

from bonis_analyzer import config, fusion  # noqa: E402

N = 120
STRICT = {c: "strict" for c in config.CATEGORIES}


def stream(*segs: tuple, n: int = N) -> np.ndarray:
    a = np.zeros(n, dtype=np.float32)
    for s, e, v in segs:
        a[s:e] = v
    return a


def spans(rs: list) -> list:
    return [(r["category"], r["start"], r["end"]) for r in rs]


class FiveSignalsTest(unittest.TestCase):
    def signals(self) -> dict:
        return {
            "frames": {"nudity": stream((10, 14, 0.9)), "gore": stream((90, 92, 0.3))},
            "subtitles": {"kissing": stream((40, 42, 0.7))},
            "speech": {"language": stream((100, 101, 0.9))},
            "audio": {"sex": stream((60, 66, 0.81)), "gore": stream((90, 92, 0.5))},
            "captions": {"implied": stream((60, 70, 0.6)), "kissing": stream((40, 50, 0.68))},
        }

    def test_all_five(self) -> None:
        levels = dict(STRICT, language="strict")
        r = fusion.fuse(self.signals(), [], N, levels, "en-US")
        self.assertEqual(spans(r), [("nudity", 8.0, 15.0), ("kissing", 38.0, 51.0), ("sex", 58.0, 67.0),
                                    ("implied", 58.0, 71.0), ("gore", 88.0, 93.0), ("language", 99.5, 101.5)])
        by = {x["category"]: x for x in r}
        # implied: captions 0.6 * 0.75 = 0.45 and audio implied absent -> no bonus
        self.assertAlmostEqual(by["implied"]["confidence"], 0.45, places=3)
        # kissing at 40-41: dialogue 0.7 and description 0.68 agree -> bonus
        nor = 1 - (1 - 0.75 * 0.7) * (1 - 0.7 * 0.68)
        self.assertAlmostEqual(by["kissing"]["confidence"], round(1 - (1 - nor) * 0.75, 3), places=3)
        self.assertEqual(by["kissing"]["note"],
                         "Possible heavy kissing. Several signals agree (dialogue, scene description).")
        # gore: picture 0.3 (0.27) + scream-level audio 0.5 (0.175): agreement lifts it over strict
        nor = 1 - (1 - 0.9 * 0.3) * (1 - 0.35 * 0.5)
        self.assertAlmostEqual(by["gore"]["confidence"], round(1 - (1 - nor) * 0.75, 3), places=3)
        self.assertEqual(by["sex"]["signals"], {"audio": 0.81})
        self.assertEqual(by["language"]["action"], "mute")

    def test_without_agreement_gore_is_missed(self) -> None:
        sig = self.signals()
        del sig["audio"]["gore"]
        r = fusion.fuse(sig, [], N, STRICT)
        self.assertNotIn("gore", [x["category"] for x in r])


class AgreementTest(unittest.TestCase):
    def test_bonus_formula_and_threshold(self) -> None:
        sig = {"frames": {"sex": stream((5, 6, 0.3))}, "audio": {"sex": stream((5, 6, 0.3))}}
        base = fusion.combine(sig, "sex", N)
        boosted = fusion.fused_score(sig, "sex", N)
        self.assertAlmostEqual(float(boosted[5]), 1 - (1 - float(base[5])) * (1 - config.AGREE_BONUS), places=6)
        self.assertEqual(float(boosted[6]), 0.0)
        sig["audio"]["sex"] = stream((5, 6, 0.29))   # below AGREE_MIN: no bonus
        self.assertAlmostEqual(float(fusion.fused_score(sig, "sex", N)[5]), float(fusion.combine(sig, "sex", N)[5]))

    def test_same_group_does_not_agree_with_itself(self) -> None:
        sig = {"subtitles": {"sex": stream((5, 6, 0.5))}, "speech": {"sex": stream((5, 6, 0.5))}}
        self.assertEqual(int(fusion.agreement(sig, "sex", N)[5]), 1)
        self.assertAlmostEqual(float(fusion.fused_score(sig, "sex", N)[5]), float(fusion.combine(sig, "sex", N)[5]))
        sig["captions"] = {"sex": stream((5, 6, 0.5))}
        self.assertEqual(int(fusion.agreement(sig, "sex", N)[5]), 2)

    def test_zero_weight_signals_never_agree(self) -> None:
        sig = {"frames": {"nudity": stream((5, 6, 0.5))}, "audio": {"nudity": stream((5, 6, 0.9))}}
        self.assertEqual(config.SIGNAL_WEIGHTS["audio"]["nudity"], 0.0)
        self.assertEqual(int(fusion.agreement(sig, "nudity", N)[5]), 1)

    def test_language_gets_no_bonus(self) -> None:
        sig = {"subtitles": {"language": stream((5, 6, 0.5))}, "speech": {"language": stream((5, 6, 0.5))},
               "frames": {"language": stream((5, 6, 0.5))}}
        self.assertAlmostEqual(float(fusion.fused_score(sig, "language", N)[5]),
                               float(fusion.combine(sig, "language", N)[5]))

    def test_never_above_one_and_deterministic(self) -> None:
        rng = np.random.default_rng(3)
        sig = {s: {c: rng.random(N).astype(np.float32) for c in config.CATEGORIES} for s in config.SIGNALS}
        for c in config.CATEGORIES:
            a, b = fusion.fused_score(sig, c, N), fusion.fused_score(sig, c, N)
            self.assertTrue(np.array_equal(a, b))
            self.assertTrue((a <= 1).all() and (a >= fusion.combine(sig, c, N) - 1e-12).all())
        self.assertEqual(fusion.fuse(sig, [30.0, 77.0], N, STRICT), fusion.fuse(sig, [77.0, 30.0], N, STRICT))


class MinDurationTest(unittest.TestCase):
    def test_category_minimums(self) -> None:
        self.assertEqual(config.CATEGORY_MIN_DURATION["sex"], 3.0)
        from unittest import mock

        timing = {c: {"snap": False, "lead_in": 0.0, "tail": 0.0} for c in config.CATEGORIES}
        with mock.patch.dict(config.CATEGORY_TIMING, timing):
            for cat, sigs in (("sex", "frames"), ("implied", "frames"), ("kissing", "frames"), ("nudity", "frames"),
                              ("gore", "frames"), ("language", "subtitles")):
                r = fusion.fuse({sigs: {cat: stream((50, 51, 0.95))}}, [], N, {cat: "strict"})
                self.assertEqual(len(r), 1, cat)
                self.assertAlmostEqual(r[0]["end"] - r[0]["start"], max(1.0, config.CATEGORY_MIN_DURATION[cat]),
                                       places=3, msg=cat)
                self.assertEqual(r[0]["start"], 50.0, cat)   # extended forward, never dropped

    def test_min_duration_at_film_end(self) -> None:
        r = fusion.fuse({"frames": {"sex": stream((119, 120, 0.95))}}, [], N, {"sex": "strict"})
        self.assertEqual(r[0]["end"], 120.0)
        self.assertGreaterEqual(r[0]["end"] - r[0]["start"], 3.0)


class OverridesTest(unittest.TestCase):
    def test_weights_and_thresholds(self) -> None:
        sig = {"audio": {"gore": stream((10, 12, 0.8))}}
        self.assertEqual(fusion.fuse(sig, [], N, {"gore": "strict"}), [])
        w = {"audio": {"gore": 1.0}}
        self.assertEqual(len(fusion.fuse(sig, [], N, {"gore": "strict"}, weights=w)), 1)
        self.assertEqual(fusion.fuse(sig, [], N, {"gore": "strict"}, weights=w, thresholds={"gore": 0.9}), [])
        self.assertEqual(fusion.fuse(sig, [], N, {"gore": "off"}, weights=w, thresholds={"gore": 0.1}), [])


class AssembleTest(unittest.TestCase):
    def test_assemble(self) -> None:
        z = np.zeros(N, np.float32)
        kw = {"sex": stream((5, 6, 0.3)), "language": stream((7, 8, 0.9))}
        lm = {"sex": stream((5, 6, 0.8)), "source": np.array("speech")}
        arrays = {"frames": {"nudity": stream((1, 2, 0.5)), "cuts": np.array([30.0, 60.0])},
                  "speech": kw, "lm": lm, "audio": {"gore": z}, "captions": {"kissing": z, "shot_start": np.zeros(3)},
                  "subtitles": None}
        sig, cuts = fusion.assemble_signals(arrays, N)
        self.assertEqual(cuts, [30.0, 60.0])
        self.assertEqual(sorted(sig), ["audio", "captions", "frames", "speech"])
        self.assertAlmostEqual(float(sig["speech"]["sex"][5]), 0.85 * 0.8, places=6)   # LM folded into speech
        self.assertNotIn("shot_start", sig["captions"])
        lm["source"] = np.array("subtitles")
        arrays["subtitles"] = {"sex": z}
        sig, _ = fusion.assemble_signals(arrays, N)
        self.assertAlmostEqual(float(sig["speech"]["sex"][5]), 0.3, places=6)
        self.assertAlmostEqual(float(sig["subtitles"]["sex"][5]), 0.68, places=6)


if __name__ == "__main__":
    unittest.main()
