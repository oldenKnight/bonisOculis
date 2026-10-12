"""Fusion on synthetic per-second score streams: thresholds, noisy-OR, shot
snapping, merging, padding, minimum duration, determinism."""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support  # noqa: E402, F401  (puts the analyzer on sys.path)

from bonis_analyzer import config, fusion, notes  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402

N = 90


def stream(*segs: tuple, n: int = N) -> np.ndarray:
    a = np.zeros(n, dtype=np.float32)
    for s, e, v in segs:
        a[s:e] = v
    return a


def spans(ranges: list) -> list:
    return [(r["category"], r["start"], r["end"]) for r in ranges]


STRICT = {c: "strict" for c in config.CATEGORIES}


class FusionTest(unittest.TestCase):
    def test_snap_to_shot_and_pad(self) -> None:
        r = fusion.fuse({"frames": {"nudity": stream((34, 40, 0.92))}}, [30.0, 50.0], 90, STRICT, "en-US")
        self.assertEqual(len(r), 1)
        r = r[0]
        self.assertEqual((r["start"], r["end"], r["cutStart"], r["cutEnd"]), (28.0, 51.0, 30.0, 50.0))
        self.assertEqual((r["confidence"], r["intensity"], r["action"]), (0.92, 3, "skip"))
        self.assertEqual((r["source"], r["review"], r["signals"]), ("auto", "pending", {"frames": 0.92}))
        self.assertEqual(r["note"], "Possible nudity. Seen in the picture.")

    def test_no_cuts_padding_only(self) -> None:
        r = fusion.fuse({"frames": {"gore": stream((10, 12, 0.5))}}, [], 90, STRICT)
        self.assertEqual(spans(r), [("gore", 8.0, 13.0)])
        self.assertEqual((r[0]["confidence"], r[0]["intensity"]), (0.45, 1))
        self.assertNotIn("cutStart", r[0])

    def test_merge_gaps_under_3s(self) -> None:
        a = stream((10, 12, 0.9), (14, 16, 0.9))
        self.assertEqual(spans(fusion.fuse({"frames": {"nudity": a}}, [], 90, STRICT)), [("nudity", 8.0, 17.0)])
        b = stream((10, 12, 0.9), (17, 19, 0.9))
        self.assertEqual(spans(fusion.fuse({"frames": {"nudity": b}}, [], 90, STRICT)),
                         [("nudity", 8.0, 13.0), ("nudity", 15.0, 20.0)])

    def test_snap_cap_20s(self) -> None:
        a = stream((30, 32, 0.9))
        self.assertEqual(spans(fusion.fuse({"frames": {"nudity": a}}, [5.0, 60.0], 90, STRICT)),
                         [("nudity", 28.0, 33.0)])
        r = fusion.fuse({"frames": {"nudity": a}}, [12.0, 45.5], 90, STRICT)
        self.assertEqual(spans(r), [("nudity", 10.0, 46.5)])
        self.assertEqual((r[0]["cutStart"], r[0]["cutEnd"]), (12.0, 45.5))

    def test_snapping_joins_runs_in_one_shot(self) -> None:
        a = stream((31, 32, 0.9), (36, 37, 0.9))
        r = fusion.fuse({"frames": {"nudity": a}}, [30.0, 40.0], 90, STRICT)
        self.assertEqual(spans(r), [("nudity", 28.0, 41.0)])

    def test_levels(self) -> None:
        a = {"frames": {"nudity": stream((10, 12, 0.7))}}
        self.assertEqual(len(fusion.fuse(a, [], 90, {"nudity": "strict"})), 1)
        self.assertEqual(len(fusion.fuse(a, [], 90, {"nudity": "moderate"})), 1)
        self.assertEqual(len(fusion.fuse(a, [], 90, {"nudity": "light"})), 0)
        self.assertEqual(len(fusion.fuse(a, [], 90, {"nudity": "off"})), 0)
        self.assertEqual(len(fusion.fuse({"frames": {"nudity": stream((10, 12, 0.8))}}, [], 90,
                                         {"nudity": "light"})), 1)

    def test_noisy_or_and_agreement(self) -> None:
        sig = {"frames": {"sex": stream((20, 22, 0.5))}, "subtitles": {"sex": stream((20, 22, 0.5))}}
        r = fusion.fuse(sig, [], 90, {"sex": "moderate"})
        self.assertEqual(len(r), 1)
        noisy_or = 1 - (1 - 0.9 * 0.5) * (1 - 0.85 * 0.5)
        expect = 1 - (1 - noisy_or) * (1 - config.AGREE_BONUS)  # picture + dialogue both >= 0.3
        self.assertAlmostEqual(r[0]["confidence"], round(expect, 3), places=3)
        self.assertEqual(r[0]["intensity"], 3)  # band 2 + two signals agree
        self.assertEqual(r[0]["note"], "Possible sexual activity. Seen in the picture; the dialogue agrees.")
        self.assertEqual(r[0]["signals"], {"frames": 0.5, "subtitles": 0.5})
        # each alone is below the moderate threshold
        self.assertEqual(fusion.fuse({"frames": sig["frames"]}, [], 90, {"sex": "moderate"}), [])

    def test_language_keeps_cue_timing(self) -> None:
        sig = {"subtitles": {"language": stream((70, 72, 0.9))}}
        r = fusion.fuse(sig, [65.0, 80.0], 90, {"language": "strict"}, "es-MX")
        self.assertEqual(spans(r), [("language", 69.5, 72.5)])
        self.assertEqual((r[0]["action"], r[0]["note"]), ("mute", "Lenguaje fuerte. En el diálogo."))
        self.assertEqual(fusion.fuse(sig, [], 90, {"language": "off"}), [])

    def test_min_duration_and_clamp(self) -> None:
        with mock.patch.dict(config.CATEGORY_TIMING, {"gore": {"snap": False, "lead_in": 0.0, "tail": 0.0}}):
            r = fusion.fuse({"frames": {"gore": stream((10, 11, 0.9))}}, [], 90, STRICT)
            self.assertEqual(spans(r), [("gore", 10.0, 11.5)])
            r = fusion.fuse({"frames": {"gore": stream((89, 90, 0.9))}}, [], 89.6, STRICT)
            self.assertEqual(spans(r), [("gore", 88.1, 89.6)])
        r = fusion.fuse({"frames": {"gore": stream((0, 1, 0.9))}}, [], 90, STRICT)
        self.assertEqual(spans(r), [("gore", 0.0, 2.0)])

    def test_deterministic(self) -> None:
        rng = np.random.default_rng(7)
        sig = {"frames": {c: (rng.random(N) > 0.93) * rng.random(N) for c in config.VISUAL_CATEGORIES},
               "subtitles": {c: (rng.random(N) > 0.95) * rng.random(N) for c in config.CATEGORIES}}
        cuts = [12.0, 30.0, 47.5, 61.0, 75.0]
        a = fusion.fuse(sig, cuts, 90, STRICT, "en-US")
        b = fusion.fuse(sig, list(reversed(cuts)), 90, STRICT, "en-US")
        self.assertEqual(a, b)
        self.assertTrue(a)
        ids = [r["id"] for r in a]
        self.assertEqual(len(ids), len(set(ids)))

    def test_ranges_build_a_valid_doc(self) -> None:
        sig = {"frames": {"nudity": stream((34, 40, 0.92)), "gore": stream((60, 70, 0.6))},
               "subtitles": {"language": stream((5, 6, 0.9)), "kissing": stream((80, 85, 0.8))}}
        rs = fusion.fuse(sig, [30.0, 50.0], 90, STRICT, "es-MX")
        doc = sf.new_doc({"media": {"title": "t", "duration": 90, "fingerprint": {"size": 1, "oshash": "0" * 16}},
                          "ranges": [sf.new_range(r) for r in rs]})
        res = sf.validate(sf.normalise(doc))
        self.assertTrue(res["ok"], res["errors"])

    def test_array_lengths_and_nan(self) -> None:
        a = np.array([0, 0, float("nan"), 0.9, 0.9], dtype=np.float32)
        r = fusion.fuse({"frames": {"nudity": a}}, [], 10, STRICT)
        self.assertEqual(spans(r), [("nudity", 1.0, 6.0)])
        self.assertEqual(fusion.fuse({}, [], 10, STRICT), [])


class NotesTest(unittest.TestCase):
    def test_templates(self) -> None:
        self.assertEqual(notes.note("gore", ["subtitles"], "en-US"), "Possible graphic violence or blood. Suggested by the dialogue.")
        self.assertEqual(notes.note("kissing", [], "es-MX"), "Posibles besos intensos. Señales débiles; conviene revisar.")
        self.assertEqual(notes.note("implied", ["frames", "subtitles", "audio"], "en-US"),
                         "Possible implied intimacy. Several signals agree (picture, dialogue, sounds).")
        for lang in ("en-US", "es-MX"):
            for c in config.CATEGORIES:
                self.assertLessEqual(len(notes.note(c, ["frames", "subtitles"], lang)), 300)


if __name__ == "__main__":
    unittest.main()
