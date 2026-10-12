"""Frame-signal code paths on synthetic inputs; real-model smoke tests run
each model once on one random-noise image (skipped without BONIS_MODELS_DIR)."""

from __future__ import annotations

import gc
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer.signals import frames as F  # noqa: E402

LABELS = config.NUDENET_LABELS


def fake_output(dets: list, anchors: int = 50) -> np.ndarray:
    """(1, 4 + C, anchors) like YOLOv8: rows of cx, cy, w, h, class scores."""
    out = np.zeros((1, 4 + len(LABELS), anchors), dtype=np.float32)
    for i, (cls, score, cx, cy, w, h) in enumerate(dets):
        out[0, 0:4, i] = (cx, cy, w, h)
        out[0, 4 + LABELS.index(cls), i] = score
    return out


class PreprocessTest(unittest.TestCase):
    def test_letterbox(self) -> None:
        img = np.full((180, 320, 3), 255, dtype=np.uint8)
        chw, scale = F.letterbox(img)
        self.assertEqual(chw.shape, (3, 320, 320))
        self.assertEqual(chw.dtype, np.float32)
        self.assertAlmostEqual(scale, 1.0)
        self.assertAlmostEqual(float(chw[:, :170].min()), 1.0, places=5)  # image area
        self.assertEqual(float(chw[:, 200:].max()), 0.0)  # bottom padding is black
        chw, scale = F.letterbox(np.zeros((90, 160, 3), dtype=np.uint8))
        self.assertAlmostEqual(scale, 0.5)

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


class YoloTest(unittest.TestCase):
    def test_decode_nms_and_scale(self) -> None:
        out = fake_output([
            ("FEMALE_BREAST_EXPOSED", 0.80, 100, 100, 40, 40),
            ("FEMALE_BREAST_EXPOSED", 0.70, 102, 101, 40, 40),  # suppressed by NMS
            ("FACE_FEMALE", 0.90, 200, 60, 30, 30),
            ("BUTTOCKS_EXPOSED", 0.15, 50, 50, 10, 10),  # below the score floor
        ])
        dets = F.decode_yolo(out, scale=2.0)
        self.assertEqual([d["class"] for d in dets], ["FACE_FEMALE", "FEMALE_BREAST_EXPOSED"])
        self.assertEqual(dets[1]["box"], [160.0, 160.0, 80.0, 80.0])
        self.assertAlmostEqual(F.nudity_score(dets), 0.8 * 0.9, places=5)

    def test_class_weights(self) -> None:
        mk = lambda cls, s: [{"class": cls, "score": s, "box": [0, 0, 1, 1]}]  # noqa: E731
        self.assertAlmostEqual(F.nudity_score(mk("FEMALE_GENITALIA_EXPOSED", 0.6)), 0.6, places=6)
        self.assertAlmostEqual(F.nudity_score(mk("ANUS_EXPOSED", 0.5)), 0.5, places=6)
        self.assertAlmostEqual(F.nudity_score(mk("BUTTOCKS_EXPOSED", 0.5)), 0.4, places=6)
        self.assertEqual(F.nudity_score(mk("MALE_BREAST_EXPOSED", 0.9)), 0.0)
        self.assertEqual(F.nudity_score(mk("FACE_MALE", 0.9)), 0.0)
        self.assertEqual(F.nudity_score([]), 0.0)

    def test_nms_deterministic_ties(self) -> None:
        boxes = np.array([[0, 0, 10, 10], [0, 0, 10, 10], [50, 50, 5, 5]], dtype=np.float32)
        self.assertEqual(F.nms(boxes, np.array([0.5, 0.5, 0.4], dtype=np.float32), 0.45), [0, 2])


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
        self.assertEqual(names, ["sex", "kissing", "implied", "gore", "safe"])
        counts = np.bincount(groups, minlength=len(names))
        self.assertTrue(all(8 <= c <= 15 for c in counts[:4]), counts)
        self.assertGreaterEqual(counts[4], 20)

    def test_fed_scorer(self) -> None:
        sc = F.FedFrameScorer({"nudity": np.array([0, 0.5, 0.9], dtype=np.float32)})
        out = sc.score_batch([(1.0, None), (2.0, None), (7.0, None)])
        self.assertEqual([o["nudity"] for o in out], [0.5, np.float32(0.9), 0.0])


@unittest.skipUnless(S.MODELS_DIR and os.path.isdir(S.MODELS_DIR), "BONIS_MODELS_DIR not set")
class RealModelSmokeTest(unittest.TestCase):
    """One forward pass per model on one 320x180 random-noise frame."""

    def test_nudenet_and_clip_shapes(self) -> None:
        from bonis_analyzer import models

        warns: list = []
        make, used = models.session_factory(2, "cpu", warns.append)
        self.assertEqual(used, "cpu")
        sc = F.ModelFrameScorer(S.MODELS_DIR, make)
        try:
            noise = np.random.default_rng(0).integers(0, 256, (180, 320, 3), dtype=np.uint8)
            chw, scale = F.letterbox(noise)
            raw = sc.nude.run(None, {sc.nude_in: chw[None]})[0]
            self.assertEqual(raw.shape, (1, 4 + len(LABELS), 2100))
            self.assertIsInstance(F.decode_yolo(raw[0], scale), list)
            emb = sc.embed([noise])
            self.assertEqual(emb.shape, (1, 512))
            self.assertTrue(np.isfinite(emb).all())
            z = F.zero_shot(emb, sc.prompts, sc.groups, sc.names)[0]
            self.assertAlmostEqual(sum(z.values()), 1.0, places=5)
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
