"""Audio-event stage: class map, class -> category mapping, per-second
accumulation, the stage on a sine+silence clip with fed class scores (test
hook), resume by chunk, no-audio skip, the "screaming alone never flags gore"
rule, and one real YAMNet shape check (skipped without BONIS_MODELS_DIR)."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config, fusion  # noqa: E402
from bonis_analyzer import models as M  # noqa: E402
from bonis_analyzer.protocol import Interrupted, Protocol  # noqa: E402
from bonis_analyzer.scan import Scan  # noqa: E402
from bonis_analyzer.signals import audio as A  # noqa: E402

NAMES = A.load_class_names(A.class_map_path())


class ClassMapTest(unittest.TestCase):
    def test_committed_class_map(self) -> None:
        p = A.class_map_path()
        with open(p, "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), config.YAMNET_CLASS_MAP_SHA256)
        self.assertEqual(len(NAMES), 521)
        self.assertEqual((NAMES[0], NAMES[22], NAMES[11]), ("Speech", "Wail, moan", "Screaming"))

    def test_every_mapped_class_exists(self) -> None:
        for cls in config.AUDIO_CLASS_MAP:
            self.assertIn(cls, NAMES)
        cols = A.category_columns(NAMES)
        self.assertEqual(sorted(cols), ["gore", "implied", "sex"])
        with self.assertRaises(ValueError):
            A.category_columns(NAMES, {"Telepathy": {"sex": 1.0}})

    def test_weights_in_range(self) -> None:
        sex = [w["sex"] for w in config.AUDIO_CLASS_MAP.values() if "sex" in w]
        self.assertEqual((max(sex), min(sex)), (0.9, 0.4))
        for per in config.AUDIO_CLASS_MAP.values():
            for w in per.values():
                self.assertTrue(0 < w <= 1)


class MappingTest(unittest.TestCase):
    def test_frame_categories_is_weighted_max(self) -> None:
        cols = A.category_columns(NAMES)
        s = np.zeros((3, 521), np.float32)
        s[0, NAMES.index("Wail, moan")] = 0.5      # 0.9 * 0.5 = 0.45
        s[0, NAMES.index("Breathing")] = 0.9       # 0.4 * 0.9 = 0.36
        s[1, NAMES.index("Gunshot, gunfire")] = 1.0
        s[2, NAMES.index("Speech")] = 1.0          # unmapped
        out = A.frame_categories(s, cols)
        self.assertAlmostEqual(float(out["sex"][0]), 0.45, places=6)
        self.assertAlmostEqual(float(out["implied"][0]), 0.35, places=6)
        self.assertAlmostEqual(float(out["gore"][1]), 0.8, places=6)
        self.assertEqual([float(out[c][2]) for c in ("sex", "implied", "gore")], [0.0, 0.0, 0.0])

    def test_accumulate_overlap(self) -> None:
        arr = {"sex": np.zeros(10, np.float32)}
        # frame 2 of a chunk starting at 3.0 covers [3.96, 4.92): seconds 3 and 4
        A.accumulate(arr, {"sex": np.array([0, 0, 0.7], np.float32)}, 3.0)
        self.assertEqual(np.flatnonzero(arr["sex"]).tolist(), [3, 4])
        A.accumulate(arr, {"sex": np.array([0.2], np.float32)}, 3.5)
        self.assertAlmostEqual(float(arr["sex"][3]), 0.7, places=6)  # max, not sum
        A.accumulate(arr, {"sex": np.array([0, 0.9], np.float32)}, 8.0, limit=8.4)  # starts past the real audio
        self.assertEqual(float(arr["sex"][8]), 0.0)

    def test_frame_count(self) -> None:
        r = config.AUDIO_RATE
        self.assertEqual([A.frame_count(int(s * r)) for s in (0.5, 0.96, 1.0, 2.0, 11.0)], [1, 1, 2, 4, 22])


class ScreamingRuleTest(unittest.TestCase):
    """A scream can never flag gore by itself; with another signal it can."""

    def test_audio_gore_alone_stays_below_every_threshold(self) -> None:
        top = max(w.get("gore", 0) for w in config.AUDIO_CLASS_MAP.values())
        worst = config.SIGNAL_WEIGHTS["audio"]["gore"] * top
        self.assertLess(worst, min(t for t in config.LEVEL_THRESHOLDS.values() if t))
        scream = config.AUDIO_CLASS_MAP["Screaming"]["gore"]
        a = np.zeros(60, np.float32)
        a[10:20] = scream
        for level in ("strict", "moderate", "light"):
            self.assertEqual(fusion.fuse({"audio": {"gore": a}}, [], 60, {"gore": level}), [])

    def test_scream_plus_picture_crosses_strict(self) -> None:
        a = np.zeros(60, np.float32)
        a[10:20] = config.AUDIO_CLASS_MAP["Screaming"]["gore"]
        f = np.zeros(60, np.float32)
        f[10:20] = 0.35   # weak picture evidence: alone below strict (0.9 * 0.35 = 0.315)
        self.assertEqual(fusion.fuse({"frames": {"gore": f}}, [], 60, {"gore": "strict"}), [])
        r = fusion.fuse({"frames": {"gore": f}, "audio": {"gore": a}}, [], 60, {"gore": "strict"})
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["intensity"], 2)  # picture + sound agree
        self.assertIn("sounds", r[0]["note"])


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class AudioStageTest(unittest.TestCase):
    def setUp(self) -> None:
        M.reset_registry()
        self.dir = os.path.join(S.tmp_root(), "audio-" + self._testMethodName)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)

    def scores(self, obj: dict) -> str:
        return S.write_json(os.path.join(self.dir, "scores.json"), obj)

    def run_scan(self, video: str, scores: str, **kw: object) -> tuple:
        work, out = os.path.join(self.dir, "w"), os.path.join(self.dir, "o.bonis.json")
        buf = io.StringIO()
        sc = Scan(S.scan_args(video, work, out, "frames,audio", scores), Protocol(buf), **kw)
        sc.run()
        with open(out, encoding="utf-8") as f:
            doc = json.load(f)
        return doc, [json.loads(x) for x in buf.getvalue().splitlines()], work, sc

    def test_fed_class_scores_on_sine_and_silence(self) -> None:
        fed = self.scores({"signals": {}, "audioClasses": {"Wail, moan": {"segments": [[22, 25, 0.9]]},
                                                           "Screaming": {"segments": [[2, 4, 1.0]]}}})
        doc, lines, work, sc = self.run_scan(S.sine_silence30(), fed)
        self.assertIn({"t": "stage", "stage": "audio", "status": "done"}, lines)
        with np.load(os.path.join(work, "audio.npz")) as z:
            sex, gore = z["sex"], z["gore"]
            self.assertEqual(sorted(z.files), ["gore", "implied", "sex"])
        hot = np.flatnonzero(sex > 0).tolist()
        self.assertEqual(hot[0], 21)       # a 0.96 s frame overlapping second 21 has its centre in 22
        self.assertEqual(hot[-1], 25)
        self.assertAlmostEqual(float(sex.max()), 0.9 * 0.9, places=5)
        self.assertAlmostEqual(float(gore.max()), 0.5, places=5)   # screaming capped at its class weight
        # sex alone at 0.81 * 0.6 = 0.486 >= strict 0.4; screaming alone flags nothing
        self.assertEqual([(r["category"], r["signals"]) for r in doc["ranges"]],
                         [("sex", {"audio": 0.81})])
        self.assertEqual(doc["ranges"][0]["note"], "Possible sexual activity. Suggested by sounds.")
        self.assertEqual(doc["scan"]["stages"]["audio"]["status"], "done")
        st = S.read_state(work)["stages"]["audio"]
        self.assertEqual(st["chunksThisRun"], 4)  # 10 + 10 + 10 + the AAC tail

    def test_chunks_overlap_by_one_second(self) -> None:
        calls = []

        class Spy(A.FedAudioScorer):
            def score(self, pcm: np.ndarray, t0: float) -> np.ndarray:
                calls.append((round(t0, 3), len(pcm)))
                return super().score(pcm, t0)

        fed = self.scores({"signals": {}})
        self.run_scan(S.sine_silence30(), fed, audio_factory=lambda: Spy({}, NAMES))
        self.assertEqual([c[0] for c in calls[:3]], [0.0, 9.0, 19.0])
        self.assertEqual([c[1] for c in calls[:3]], [160000, 176000, 176000])

    def test_resume_by_chunk(self) -> None:
        video = S.video90()
        fed = self.scores({"signals": {}, "audioClasses": {"Pant": {"segments": [[5, 8, 0.8]]},
                                                           "Gunshot, gunfire": {"segments": [[75, 77, 0.9]]}}})
        state = {"calls": 0, "die_at": 8}

        class Dying(A.FedAudioScorer):
            def score(self, pcm: np.ndarray, t0: float) -> np.ndarray:
                state["calls"] += 1
                if state["calls"] == state["die_at"]:
                    raise Interrupted("killed")
                return super().score(pcm, t0)

        classes = {"Pant": np.zeros(90, np.float32), "Gunshot, gunfire": np.zeros(90, np.float32)}
        classes["Pant"][5:8] = 0.8
        classes["Gunshot, gunfire"][75:77] = 0.9
        work = os.path.join(self.dir, "w")
        args = S.scan_args(video, work, os.path.join(self.dir, "o.bonis.json"), "audio", fed)
        with self.assertRaises(Interrupted):
            Scan(args, Protocol(io.StringIO()), audio_factory=lambda: Dying(classes, NAMES)).run()
        st = S.read_state(work)["stages"]["audio"]
        self.assertEqual((st["status"], st["resumeAt"]), ("running", 60.0))  # checkpoint after 6 chunks
        self.assertEqual(M.loaded(), [])  # released even on interrupt
        spy = A.FedAudioScorer(classes, NAMES)
        buf = io.StringIO()
        Scan(args, Protocol(buf), audio_factory=lambda: spy).run()
        self.assertEqual(spy.calls[0], 59.0)  # resumes at the checkpoint with its 1 s overlap
        self.assertIn({"t": "stage", "stage": "audio", "status": "running", "resumeAt": 60.0},
                      [json.loads(x) for x in buf.getvalue().splitlines()])
        with np.load(os.path.join(work, "audio.npz")) as z:
            resumed = {k: np.array(z[k]) for k in z.files}
        work2 = os.path.join(self.dir, "w2")
        Scan(S.scan_args(video, work2, os.path.join(self.dir, "o2.bonis.json"), "audio", fed), Protocol(io.StringIO()),
             audio_factory=lambda: A.FedAudioScorer(classes, NAMES)).run()
        with np.load(os.path.join(work2, "audio.npz")) as z:
            for k in z.files:
                self.assertTrue(np.array_equal(resumed[k], z[k]), k)
        self.assertGreater(float(resumed["gore"][76]), 0.7)
        self.assertGreater(float(resumed["sex"][6]), 0.5)

    def test_no_audio_stream_is_skipped(self) -> None:
        doc, lines, work, _ = self.run_scan(S.silent_video20(), self.scores({"signals": {}}))
        self.assertIn({"t": "stage", "stage": "audio", "status": "skipped"}, lines)
        self.assertIn("This movie has no sound track; sounds were not checked.", doc["scan"]["warnings"])
        self.assertEqual(doc["scan"]["stages"]["audio"]["status"], "skipped")
        self.assertEqual(doc["scan"]["status"], "partial")  # subtitles stage not requested here
        self.assertNotIn("audio.npz", os.listdir(work))


@unittest.skipUnless(S.model_file(config.YAMNET_FILE), "YAMNet not available (BONIS_MODELS_DIR)")
class RealYamnetTest(unittest.TestCase):
    def test_shapes_on_two_seconds_of_sine(self) -> None:
        make, _ = M.session_factory(2, "cpu", lambda m: None)
        sc = A.YamnetScorer(S.MODELS_DIR, make)
        try:
            x = (0.3 * np.sin(2 * np.pi * 440 * np.arange(32000) / 16000)).astype(np.float32)
            out = sc.score(x, 0.0)
            self.assertEqual(out.shape, (4, 521))
            self.assertEqual(out.shape[0], A.frame_count(len(x)))
            self.assertTrue(np.isfinite(out).all() and out.min() >= 0 and out.max() <= 1)
            per = A.frame_categories(out, A.category_columns(sc.names))
            self.assertLess(float(per["sex"].max()), 0.5)  # a sine tone is not a moan
        finally:
            sc.close()


if __name__ == "__main__":
    unittest.main()
