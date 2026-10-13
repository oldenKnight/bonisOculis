"""Frame-signal code paths on synthetic inputs; real-model smoke tests run
each model once on one random-noise image (skipped without BONIS_MODELS_DIR)."""

from __future__ import annotations

import gc
import json
import os
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer.signals import frames as F  # noqa: E402

M = "/nonexistent"


class FakeSession:
    """ORT stand-in: records batch sizes, returns fixed logits per call."""

    class _In:
        name = "pixel_values"

    def __init__(self, logits=None, shape=None) -> None:
        self.calls: list = []
        self.logits = logits
        self.shape = shape

    def get_inputs(self) -> list:
        return [self._In()]

    def run(self, _outs, feed) -> list:
        x = next(iter(feed.values()))
        self.calls.append(x.shape)
        if self.shape is not None:
            return [np.zeros(self.shape, np.float32)]
        if x.shape[1:] == (3, 224, 224):  # CLIP vision: embeddings
            e = np.zeros((x.shape[0], 512), np.float32)
            e[:, 0] = 1.0
            return [e]
        return [np.tile(np.asarray(self.logits, np.float32), (x.shape[0], 1))]


def write_models(d: str, pre: object = None, cfg: object = None) -> str:
    os.makedirs(d, exist_ok=True)
    for name in (config.NSFW_FILE, config.CLIP_VISION_FILE):
        with open(os.path.join(d, name), "wb") as f:
            f.write(b"x")
    for name, obj in ((config.NSFW_PREPROCESSOR_FILE, pre), (config.NSFW_CONFIG_FILE, cfg)):
        if obj is not None:
            with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                f.write(obj if isinstance(obj, str) else json.dumps(obj))
    return d


class PreprocessTest(unittest.TestCase):
    def test_nsfw_preprocess(self) -> None:
        img = np.zeros((180, 320, 3), dtype=np.uint8)
        img[:, 160:] = 255
        x = F.nsfw_preprocess(img)
        self.assertEqual(x.shape, (3, 384, 384))
        self.assertEqual(x.dtype, np.float32)
        self.assertTrue(x.flags["C_CONTIGUOUS"])
        # plain resize (no crop, no padding): left half black -> -1, right half white -> +1
        self.assertTrue(np.allclose(x[:, :, :150], -1.0, atol=1e-5))
        self.assertTrue(np.allclose(x[:, :, -150:], 1.0, atol=1e-5))
        y = F.nsfw_preprocess(np.full((10, 20, 3), 51, np.uint8), size=32, mean=(0.2, 0.2, 0.2), std=(0.1, 0.1, 0.1))
        self.assertEqual(y.shape, (3, 32, 32))
        self.assertTrue(np.allclose(y, 0.0, atol=1e-5))

    def test_clip_preprocess(self) -> None:
        img = np.zeros((180, 320, 3), dtype=np.uint8)
        img[:, 160:] = 255
        x = F.clip_preprocess(img)
        self.assertEqual(x.shape, (3, 224, 224))
        mean = np.array(config.CLIP_MEAN)[:, None]
        std = np.array(config.CLIP_STD)[:, None]
        self.assertTrue(np.allclose(x[:, 100, :5], (0 - mean) / std, atol=1e-4))
        self.assertTrue(np.allclose(x[:, 100, -5:], (1 - mean) / std, atol=1e-4))

    def test_resize_identity(self) -> None:
        img = np.random.default_rng(1).integers(0, 255, (10, 12, 3)).astype(np.uint8)
        self.assertTrue(np.array_equal(F.resize_bilinear(img, 10, 12), img.astype(np.float32)))


class NudityFusionTest(unittest.TestCase):
    def test_softmax(self) -> None:
        p = F.softmax(np.array([[0.0, 0.0], [10.0, -10.0], [1000.0, 1001.0]]))
        self.assertTrue(np.allclose(p.sum(axis=1), 1.0))
        self.assertAlmostEqual(p[0, 1], 0.5)
        self.assertLess(p[1, 1], 1e-8)
        self.assertAlmostEqual(p[2, 1], 1 / (1 + np.exp(-1)), places=9)  # no overflow

    def test_fuse_nudity(self) -> None:
        self.assertEqual(config.CLIP_NUDITY_WEIGHT, 0.8)
        self.assertAlmostEqual(F.fuse_nudity(0.3, 0.9), 0.72)   # CLIP group, discounted
        self.assertAlmostEqual(F.fuse_nudity(0.9, 0.95), 0.9)   # classifier wins
        self.assertEqual(F.fuse_nudity(0.0, 0.0), 0.0)
        self.assertLessEqual(F.fuse_nudity(1.0, 1.0), 1.0)
        # the CLIP group alone reaches strict (0.40) at half the softmax mass, moderate (0.60) at
        # 0.75, and light (0.80) only at certainty (TUNING.md)
        self.assertGreaterEqual(F.fuse_nudity(0.0, 0.5), config.LEVEL_THRESHOLDS["strict"])
        self.assertLess(F.fuse_nudity(0.0, 0.49), config.LEVEL_THRESHOLDS["strict"])
        self.assertGreaterEqual(F.fuse_nudity(0.0, 0.75), config.LEVEL_THRESHOLDS["moderate"])
        self.assertLess(F.fuse_nudity(0.0, 0.99), config.LEVEL_THRESHOLDS["light"])


class GateTest(unittest.TestCase):
    def test_gate_selects(self) -> None:
        self.assertEqual((config.CLIP_GATE, config.GATE_STRIDE), (0.10, 4))
        self.assertTrue(F.gate_selects(0.0, 0.0))     # stride second
        self.assertTrue(F.gate_selects(8.2, 0.0))     # rounds to 8
        self.assertFalse(F.gate_selects(5.0, 0.09))
        self.assertTrue(F.gate_selects(5.0, 0.10))    # CLIP leans towards nudity
        self.assertTrue(F.gate_selects(5.0, 0.0, stride=1))
        picked = [t for t in range(100) if F.gate_selects(float(t), 0.0)]
        self.assertEqual(len(picked), 25)             # coverage never below 1 in GATE_STRIDE


class SettingsTest(unittest.TestCase):
    def test_defaults_without_json(self) -> None:
        d = write_models(os.path.join(S.tmp_root(), "nsfw-defaults"))
        st = F.nsfw_settings(d)
        self.assertEqual((st["size"], st["mean"], st["std"], st["index"]),
                         (384, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5), 1))

    def test_reads_model_json(self) -> None:
        d = write_models(os.path.join(S.tmp_root(), "nsfw-json"),
                         {"size": {"height": 224, "width": 224}, "image_mean": [0.4, 0.4, 0.4], "image_std": [0.2, 0.2, 0.2]},
                         {"id2label": {"0": "nsfw", "1": "sfw"}})
        st = F.nsfw_settings(d)
        self.assertEqual((st["size"], st["mean"], st["std"], st["index"]), (224, (0.4,) * 3, (0.2,) * 3, 0))

    def test_rejects_bad_json(self) -> None:
        from bonis_analyzer.protocol import ModelMissing

        root = os.path.join(S.tmp_root(), "nsfw-bad")
        for i, (pre, cfg) in enumerate((("{not json", None),
                                        ({"size": {"height": 384, "width": 200}}, None),
                                        ({"image_std": [0, 1, 1]}, None),
                                        ({"image_mean": "x"}, None),
                                        (None, {"id2label": {"0": "a", "1": "b"}}),
                                        (None, {"id2label": {"0": "sfw", "1": "nsfw", "2": "x"}}))):
            with self.assertRaises(ModelMissing, msg=str((pre, cfg))):
                F.nsfw_settings(write_models(os.path.join(root, str(i)), pre, cfg))


class ScorerTest(unittest.TestCase):
    """ModelFrameScorer with ORT stand-ins: batching, shapes, fusion."""

    def make(self, logits, name: str, shape=None):
        d = write_models(os.path.join(S.tmp_root(), "scorer-" + name))
        sessions: list = []

        def factory(path: str) -> FakeSession:
            sessions.append((os.path.basename(path), FakeSession(logits, shape if path.endswith(config.NSFW_FILE) else None)))
            return sessions[-1][1]

        sc = F.ModelFrameScorer(d, factory)
        return sc, dict(sessions)

    def test_classifier_batches_of_eight(self) -> None:
        sc, sess = self.make([0.0, np.log(3.0)], "batch")  # softmax -> nsfw 0.75
        p = sc.classify([np.zeros((180, 320, 3), np.uint8)] * 19)
        self.assertEqual([c[0] for c in sess[config.NSFW_FILE].calls], [8, 8, 3])
        self.assertEqual(sess[config.NSFW_FILE].calls[0][1:], (3, 384, 384))
        self.assertTrue(np.allclose(p, 0.75))

    def test_gate_and_fusion(self) -> None:
        sc, sess = self.make([0.0, np.log(3.0)], "gate")  # classifier says 0.75 whenever asked
        frames = [(float(t), np.zeros((180, 320, 3), np.uint8)) for t in range(19)]
        z = F.zero_shot(sc.embed([frames[0][1]]), sc.prompts, sc.groups, sc.names)[0]
        self.assertLess(z["nudity"], config.CLIP_GATE)  # the fake embedding is not "nude" to CLIP
        out = sc.score_batch(frames)
        # only every GATE_STRIDE-th second reaches the classifier: 0, 4, 8, 12, 16
        self.assertEqual([c[0] for c in sess[config.NSFW_FILE].calls], [5])
        self.assertEqual((sc.scored, sc.classified), (19, 5))
        clip_only = config.CLIP_NUDITY_WEIGHT * z["nudity"]
        for (t, _), o in zip(frames, out):
            self.assertEqual(sorted(o), sorted(config.VISUAL_CATEGORIES))
            self.assertAlmostEqual(o["nudity"], 0.75 if int(t) % config.GATE_STRIDE == 0 else clip_only, places=5)
            self.assertAlmostEqual(o["gore"], z["gore"], places=6)
        # worst case: every frame through the classifier (gate 0), still in batches of 8
        with mock.patch.object(config, "CLIP_GATE", 0.0):
            sess[config.NSFW_FILE].calls.clear()
            out = sc.score_batch(frames)
        self.assertEqual([c[0] for c in sess[config.NSFW_FILE].calls], [8, 8, 3])
        self.assertTrue(all(abs(o["nudity"] - 0.75) < 1e-6 for o in out))
        sc.close()
        self.assertIsNone(sc.nsfw)
        self.assertEqual(sc.score_batch([]), [])

    def test_clip_group_can_win(self) -> None:
        sc, _ = self.make([5.0, -5.0], "sfw")  # classifier: clearly safe
        p = sc.classify([np.zeros((18, 32, 3), np.uint8)])
        self.assertLess(float(p[0]), 1e-4)
        sc.prompts = np.eye(len(sc.names), 512, dtype=np.float32)[np.asarray(sc.groups)]  # one axis per group
        sc.prompts = sc.prompts / np.linalg.norm(sc.prompts, axis=1, keepdims=True)
        nud = sc.names.index("nudity")  # CLIP certain -> over the gate -> classifier asked (says safe)
        sc.embed = lambda frames: np.eye(1, 512, nud, dtype=np.float32).repeat(len(frames), 0)  # type: ignore
        o = sc.score_batch([(0.0, np.zeros((18, 32, 3), np.uint8))])[0]
        self.assertAlmostEqual(o["nudity"], config.CLIP_NUDITY_WEIGHT * 1.0, places=4)

    def test_bad_output_shape(self) -> None:
        sc, _ = self.make(None, "shape", shape=(1, 3))
        with self.assertRaises(ValueError):
            sc.classify([np.zeros((18, 32, 3), np.uint8)])

    def test_missing_model(self) -> None:
        from bonis_analyzer.protocol import ModelMissing

        d = os.path.join(S.tmp_root(), "scorer-missing")
        os.makedirs(d, exist_ok=True)
        with self.assertRaises(ModelMissing) as cm:
            F.ModelFrameScorer(d, lambda p: FakeSession([0, 0]))
        self.assertIn(config.NSFW_FILE, str(cm.exception))


class ZeroShotTest(unittest.TestCase):
    def test_group_softmax(self) -> None:
        prompts = np.eye(4, dtype=np.float32)
        groups = np.array([0, 0, 1, 2])
        img = np.array([[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]], dtype=np.float32)
        out = F.zero_shot(img, prompts, groups, ["gore", "kissing", "safe"])
        self.assertGreater(out[0]["gore"], 0.99)
        self.assertGreater(out[1]["safe"], 0.99)
        for o in out:
            self.assertAlmostEqual(sum(o.values()), 1.0, places=6)

    def test_committed_prompts_load(self) -> None:
        emb, groups, names = F.load_prompts(F.prompts_path("/nonexistent"))
        self.assertEqual(emb.shape[1], 512)
        self.assertEqual(emb.dtype, np.float32)
        self.assertTrue(np.allclose(np.linalg.norm(emb, axis=1), 1.0, atol=1e-5))
        self.assertEqual(names, ["sex", "kissing", "implied", "gore", "nudity", "safe"])
        counts = np.bincount(groups, minlength=len(names))
        self.assertTrue(all(8 <= c <= 15 for c in counts[:4]), counts)
        self.assertTrue(8 <= counts[4] <= 12, counts)
        self.assertGreaterEqual(counts[5], 20)
        self.assertEqual(config.CLIP_NUDITY_GROUP, "nudity")

    def test_prompt_index_matches_npz(self) -> None:
        from bonis_analyzer.signals import clip_prompts as P

        emb, groups, names = F.load_prompts(F.prompts_path("/nonexistent"))
        self.assertEqual(names, P.GROUPS)
        self.assertEqual(len(emb), sum(len(P.PROMPTS[g]) for g in P.GROUPS))
        with open(os.path.join(os.path.dirname(F.prompts_path("/nonexistent")), "clip_prompts.json"), encoding="utf-8") as f:
            idx = json.load(f)
        self.assertEqual([p["text"] for p in idx["prompts"]], [t for g in P.GROUPS for t in P.PROMPTS[g]])

    def test_fed_scorer(self) -> None:
        sc = F.FedFrameScorer({"nudity": np.array([0, 0.5, 0.9], dtype=np.float32)})
        out = sc.score_batch([(1.0, None), (2.0, None), (7.0, None)])
        self.assertEqual([o["nudity"] for o in out], [0.5, np.float32(0.9), 0.0])

    def test_fed_scorer_parts(self) -> None:
        parts = {"nsfw": np.array([0.1, 0.2, 0.0], np.float32), "clipNudity": np.array([0.9, 0.0, 0.5], np.float32)}
        sc = F.FedFrameScorer({"nudity": np.array([0.0, 0.0, 0.6], np.float32)}, parts)
        out = sc.score_batch([(0.0, None), (1.0, None), (2.0, None), (9.0, None)])
        # t=0: CLIP 0.9 (gated in; 0.72 > 0.1); t=1: CLIP 0 and not a stride second -> classifier
        # skipped, 0; t=2: fed nudity 0.6; t=9: nothing
        self.assertEqual([round(o["nudity"], 4) for o in out], [0.72, 0.0, 0.6, 0.0])
        sc = F.FedFrameScorer({}, {"nsfw": np.array([0, 0, 0, 0, 0.9, 0.9], np.float32),
                                   "clipNudity": np.array([0, 0, 0, 0, 0, 0.2], np.float32)})
        out = sc.score_batch([(4.0, None), (5.0, None)])  # stride second; CLIP over the gate
        self.assertEqual([round(o["nudity"], 4) for o in out], [0.9, 0.9])


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class FedPartsScanTest(unittest.TestCase):
    """--scores-from "framesParts": the scan fuses classifier + CLIP nudity like the real scorer."""

    def run_scan(self, fed: dict, name: str) -> dict:
        import io

        from bonis_analyzer import models as M
        from bonis_analyzer.protocol import Protocol
        from bonis_analyzer.scan import Scan

        M.reset_registry()
        d = os.path.join(S.tmp_root(), "parts-" + name)
        os.makedirs(d, exist_ok=True)
        scores = S.write_json(os.path.join(d, "scores.json"), fed)
        out = os.path.join(d, "o.bonis.json")
        Scan(S.scan_args(S.video90(), os.path.join(d, "w"), out, "frames", scores), Protocol(io.StringIO())).run()
        with open(out, encoding="utf-8") as f:
            return json.load(f)

    def test_clip_nudity_alone_flags_at_strict(self) -> None:
        # CLIP group 0.6 -> 0.8 x 0.6 = 0.48: over strict (0.40), not over moderate (0.60)
        fed = {"framesParts": {"clipNudity": {"segments": [[10, 13, 0.6]]}, "nsfw": {"segments": [[60, 62, 0.95]]}}}
        doc = self.run_scan(fed, "strict")
        nud = sorted((r["start"], r["confidence"]) for r in doc["ranges"] if r["category"] == "nudity")
        self.assertEqual(len(nud), 2)
        self.assertAlmostEqual(nud[0][1], 0.48, places=2)
        self.assertAlmostEqual(nud[1][1], 0.95, places=2)
        self.assertLessEqual(nud[0][0], 10.0)
        # a fed frames array for another category still works alongside the parts
        fed["signals"] = {"frames": {"gore": {"segments": [[40, 42, 0.9]]}}}
        doc = self.run_scan(fed, "with-signals")
        self.assertEqual(sorted({r["category"] for r in doc["ranges"]}), ["gore", "nudity"])
        self.assertEqual(sum(1 for r in doc["ranges"] if r["category"] == "nudity"), 2)

    def test_bad_parts_key(self) -> None:
        from bonis_analyzer.protocol import BadInput
        from bonis_analyzer.scan import load_scores_from

        p = S.write_json(os.path.join(S.tmp_root(), "bad-parts.json"), {"framesParts": {"nudenet": [0.5]}})
        with self.assertRaises(BadInput):
            load_scores_from(p, 10)
        p = S.write_json(os.path.join(S.tmp_root(), "ok-parts.json"), {"framesParts": {"nsfw": [0.5, 2.0]}})
        self.assertEqual(load_scores_from(p, 3)["framesParts"]["nsfw"].tolist(), [0.5, 1.0, 0.0])


@unittest.skipUnless(S.MODELS_DIR and os.path.isdir(S.MODELS_DIR), "BONIS_MODELS_DIR not set")
class RealModelSmokeTest(unittest.TestCase):
    """One forward pass per model on one 320x180 random-noise frame."""

    def test_classifier_and_clip_shapes(self) -> None:
        from bonis_analyzer import models

        warns: list = []
        make, used = models.session_factory(2, "cpu", warns.append)
        self.assertEqual(used, "cpu")
        sc = F.ModelFrameScorer(S.MODELS_DIR, make)
        try:
            self.assertEqual(sc.nsfw_cfg, {"size": 384, "mean": (0.5, 0.5, 0.5), "std": (0.5, 0.5, 0.5), "index": 1})
            noise = np.random.default_rng(0).integers(0, 256, (180, 320, 3), dtype=np.uint8)
            logits = sc.nsfw_logits([noise])
            self.assertEqual(logits.shape, (1, 2))
            self.assertTrue(np.isfinite(logits).all())
            probs = F.softmax(logits)
            self.assertAlmostEqual(float(probs.sum()), 1.0, places=6)
            emb = sc.embed([noise])
            self.assertEqual(emb.shape, (1, 512))
            self.assertTrue(np.isfinite(emb).all())
            z = F.zero_shot(emb, sc.prompts, sc.groups, sc.names)[0]
            self.assertAlmostEqual(sum(z.values()), 1.0, places=5)
            out = sc.score_batch([(0.0, noise)])[0]
            self.assertAlmostEqual(out["nudity"], F.fuse_nudity(float(probs[0, 1]), z["nudity"]), places=5)
            sys.stderr.write("\n[frames] noise frame: nsfw %.4f, CLIP nudity group %.4f\n" % (probs[0, 1], z["nudity"]))
        finally:
            sc.close()
            del sc
            gc.collect()

    def test_device_fallback_warns(self) -> None:
        from bonis_analyzer import models

        warns: list = []
        providers, used = models.choose_providers("dml", warns.append)
        if "DmlExecutionProvider" not in providers:
            self.assertEqual((providers, used), (["CPUExecutionProvider"], "cpu"))
            self.assertEqual(len(warns), 1)


if __name__ == "__main__":
    unittest.main()
