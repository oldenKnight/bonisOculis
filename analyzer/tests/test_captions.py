"""Scene-caption stage: shots and budget, byte-level BPE decoding, the
no-repeat-ngram rule, preprocessing, the in-memory ONNX fix for the merged
decoder, fed captions through the scan (lexicon + caption LM, scores only,
never text), resume every 10 shots, and one real Florence-2 generation on ONE
noise frame (skipped without BONIS_MODELS_DIR)."""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer import models as M  # noqa: E402
from bonis_analyzer.protocol import Interrupted, Protocol  # noqa: E402
from bonis_analyzer.scan import Scan  # noqa: E402
from bonis_analyzer.signals import captions as C  # noqa: E402
from bonis_analyzer.signals import lm as L  # noqa: E402
from bonis_analyzer.signals import onnx_fix as X  # noqa: E402

FLORENCE = all(S.model_file(f) for f in list(config.FLORENCE_FILES.values()) + [config.FLORENCE_TOKENIZER_FILE])


class ShotsTest(unittest.TestCase):
    def test_shots_from_cuts(self) -> None:
        self.assertEqual(C.shots_from_cuts([30.0, 50.0], 90.0),
                         [(0.0, 15.0), (15.0, 30.0), (30.0, 50.0), (50.0, 70.0), (70.0, 90.0)])
        self.assertEqual(C.shots_from_cuts(None, 25.0), [(0.0, 10.0), (10.0, 20.0), (20.0, 25.0)])
        self.assertEqual(C.shots_from_cuts([], 12.0), [(0.0, 12.0)])
        self.assertEqual(C.shots_from_cuts([0.0, 5.0, 5.0, 99.0], 10.0), [(0.0, 5.0), (5.0, 10.0)])
        self.assertEqual(C.shots_from_cuts([], 0.0), [])

    def test_budget_keeps_hot_shots_and_samples_the_rest(self) -> None:
        pr = np.array([0, 0.1, 0.5, 0, 0, 0, 0, 0.3, 0, 0], np.float32)
        self.assertEqual(C.select_shots(pr, budget=20), list(range(10)))
        sel = C.select_shots(pr, budget=4, threshold=0.2)
        self.assertEqual(len(sel), 4)
        self.assertTrue({2, 7} <= set(sel))
        self.assertEqual(sel, C.select_shots(pr, budget=4, threshold=0.2))   # deterministic
        self.assertEqual(C.select_shots(pr, budget=1, threshold=0.2), [2])   # hot over budget: highest first

    def test_priority_and_spread(self) -> None:
        other = np.zeros(30, np.float32)
        other[12] = 0.4
        shots = [(0.0, 10.0), (10.0, 20.0), (20.0, 30.0)]
        self.assertEqual(C.shot_priority(shots, other).tolist(), [0.0, np.float32(0.4), 0.0])
        out = C.spread(shots, {1: {"kissing": 0.6}}, 30)
        self.assertEqual(np.flatnonzero(out["kissing"]).tolist(), list(range(10, 20)))
        self.assertEqual(sorted(out), sorted(C.CAPTION_CATEGORIES))

    def test_people(self) -> None:
        self.assertTrue(C.mentions_people("A man and a woman are sitting on a bed."))
        self.assertTrue(C.mentions_people("The couple is kissing."))
        self.assertFalse(C.mentions_people("A colorful test pattern with a grid of lines."))
        self.assertFalse(C.mentions_people("Mountains behind a manor."))  # whole words only


class DecodeTest(unittest.TestCase):
    def test_toy_byte_level_bpe(self) -> None:
        b2u = C.bytes_to_unicode()
        e_acute = "".join(b2u[b] for b in "é".encode("utf-8"))
        vocab = {"<s>": 0, "<pad>": 1, "</s>": 2, b2u[ord(" ")] + "a": 5, "b": 6, e_acute: 7, "Ċ": 8}
        d = C.ByteBpeDecoder(vocab, [{"id": 9, "content": "<loc_1>"}], [[0, 3], [9, 9]])
        self.assertEqual(d.decode([0, 5, 6, 7, 2]), "abé")
        self.assertEqual(d.decode([5, 8, 6]), "a\nb")
        self.assertEqual(d.decode([5, 9, 6]), "ab")                     # special added token skipped
        self.assertEqual(d.decode([5, 9, 6], skip_special=False), "a<loc_1>b")
        self.assertEqual(d.decode([5, 4000]), "a")                       # unknown id ignored
        self.assertEqual(len(C.bytes_to_unicode()), 256)

    def test_committed_prompt_ids(self) -> None:
        p = C.load_prompts(C.prompts_path())
        self.assertEqual(p["task"], "<MORE_DETAILED_CAPTION>")
        self.assertEqual((p["promptIds"][0], p["promptIds"][-1]), (0, 2))
        self.assertEqual((p["decoderStart"], p["forcedBos"], p["eos"], p["noRepeatNgram"]), (2, 0, 2, 3))
        self.assertEqual(p["tokenizerSha256"], "d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac")

    @unittest.skipUnless(FLORENCE, "Florence-2 tokenizer not available")
    def test_matches_reference_tokenizer_decode(self) -> None:
        p = C.load_prompts(C.prompts_path())
        d = C.ByteBpeDecoder.from_file(S.model_file(config.FLORENCE_TOKENIZER_FILE), p["specialIdRanges"])
        for chk in p["decodeChecks"]:
            self.assertEqual(d.decode(chk["ids"]), chk["text"].strip())

    def test_no_repeat_ngram(self) -> None:
        self.assertEqual(C.banned_ngram_tokens([1, 2, 3, 1, 2], 3), [3])
        self.assertEqual(C.banned_ngram_tokens([1, 2, 3, 4], 3), [])
        self.assertEqual(C.banned_ngram_tokens([5, 5], 1), [5, 5])
        self.assertEqual(C.banned_ngram_tokens([1], 3), [])

    def test_preprocess(self) -> None:
        img = np.zeros((768, 768, 3), np.uint8)
        img[:, 384:] = 255
        x = C.preprocess(img)
        self.assertEqual((x.shape, x.dtype), ((1, 3, 768, 768), np.float32))
        self.assertAlmostEqual(float(x[0, 0, 0, 0]), (0 - 0.485) / 0.229, places=5)
        self.assertAlmostEqual(float(x[0, 2, 0, 767]), (1 - 0.406) / 0.225, places=5)


def _s(num: int, text: str) -> X.Field:
    return (num, 2, text.encode("utf-8"))


def _node(op: str, ins: list, outs: list, attrs: list = ()) -> bytes:
    return X.encode([_s(1, i) for i in ins] + [_s(2, o) for o in outs] + [_s(4, op)] + [(5, 2, a) for a in attrs])


def _vi(name: str, typed: bool = True) -> bytes:
    f = [_s(1, name)]
    if typed:
        f.append((2, 2, X.encode([(1, 2, X.encode([(1, 0, X._enc_varint(1))]))])))  # tensor(float)
    return X.encode(f)


class OnnxFixTest(unittest.TestCase):
    """The merged-decoder defect, rebuilt in miniature with the wire encoder."""

    def model(self) -> bytes:
        then_g = X.encode([(1, 2, _node("Add", ["a", "b"], ["y_cast"])), _s(2, "then"), (12, 2, _vi("logits"))])
        else_g = X.encode([(1, 2, _node("Neg", ["a"], ["unused"])), _s(2, "else"), (12, 2, _vi("x_in"))])
        attr_then = X.encode([_s(1, "then_branch"), (6, 2, then_g), (20, 0, X._enc_varint(5))])
        attr_else = X.encode([_s(1, "else_branch"), (6, 2, else_g), (20, 0, X._enc_varint(5))])
        graph = X.encode([(1, 2, _node("If", ["cond"], ["y_cast"], [attr_then, attr_else])),
                          (1, 2, _node("Cast", ["y_cast"], ["logits"])), _s(2, "main"),
                          (11, 2, _vi("cond")), (11, 2, _vi("a")), (11, 2, _vi("b")), (11, 2, _vi("x_in")),
                          (12, 2, _vi("logits"))])
        return X.encode([(1, 0, X._enc_varint(8)), (7, 2, graph)])

    def branches(self, model: bytes) -> dict:
        graph = [p for f, w, p in X.parse(model) if f == 7][0]
        node = X.parse(bytes([p for f, w, p in X.parse(bytes(graph)) if f == 1][0]))
        out = {}
        for f, w, p in node:
            if f == 5:
                attr = X.parse(bytes(p))
                name = X._strings(attr, 1)[0]
                sub = X.parse(bytes([ap for af, aw, ap in attr if af == 6][0]))
                outs = [X.parse(bytes(sp)) for sf, sw, sp in sub if sf == 12]
                nodes = [X.parse(bytes(sp)) for sf, sw, sp in sub if sf == 1]
                out[name] = {"outputs": [(X._strings(o, 1)[0], any(x[0] == 2 for x in o)) for o in outs],
                             "nodes": [(X._strings(n, 4)[0], X._strings(n, 1), X._strings(n, 2)) for n in nodes]}
        return out

    def test_roundtrip(self) -> None:
        m = self.model()
        self.assertEqual(X.encode(X.parse(m)), m)

    def test_fix(self) -> None:
        fixed, k = X.fix_model(self.model())
        self.assertEqual(k, 2)
        br = self.branches(fixed)
        # then: produced inside under the If output's name -> output renamed, stale type dropped
        self.assertEqual(br["then_branch"]["outputs"], [("y_cast", False)])
        # else: a genuine outer value -> Identity inside the branch
        self.assertEqual(br["else_branch"]["outputs"], [("x_in__bo_id", True)])
        self.assertIn(("Identity", ["x_in"], ["x_in__bo_id"]), br["else_branch"]["nodes"])
        self.assertEqual(X.fix_model(fixed), (fixed, 0))  # idempotent


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class CaptionStageTest(unittest.TestCase):
    CAPTIONS = [[0, 30, "A colorful test pattern with a grid of lines."],
                [30, 50, "A man and a woman are kissing on a couch."],
                [50, 90, "A man is lying on the floor in a pool of blood."]]

    def setUp(self) -> None:
        M.reset_registry()
        self.dir = os.path.join(S.tmp_root(), "cap-" + self._testMethodName)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)

    def scan(self, video: str, stages: str, fed: dict, **kw: object) -> tuple:
        scores = S.write_json(os.path.join(self.dir, "scores.json"), fed)
        work, out = os.path.join(self.dir, "w"), os.path.join(self.dir, "o.bonis.json")
        buf = io.StringIO()
        Scan(S.scan_args(video, work, out, stages, scores), Protocol(buf), **kw).run()
        with open(out, encoding="utf-8") as f:
            raw = f.read()
        return json.loads(raw), raw, [json.loads(x) for x in buf.getvalue().splitlines()], work

    def test_fed_captions_lexicon_and_caption_lm(self) -> None:
        fake_lm = L.FakeLM({"kissing": {"kissing": 0.8}, "blood": {"gore": 0.9}})
        doc, raw, lines, work = self.scan(S.video90(), "frames,captions",
                                          {"signals": {}, "captionsText": self.CAPTIONS},
                                          lm_factory=lambda: fake_lm)
        self.assertIn({"t": "stage", "stage": "captions", "status": "done"}, lines)
        # only the three shots whose captions mention people (30-50, 50-70, 70-90) reach the LM,
        # after the captioner is released
        self.assertEqual(len(fake_lm.calls), 3)
        hist = [(e, n) for e, n, _ in M.history()]
        self.assertLess(hist.index(("release", "captions")), hist.index(("load", "captions-lm")))
        self.assertEqual(M.max_concurrent(), 1)
        got = {(r["category"], r["start"], r["end"]): r["signals"] for r in doc["ranges"]}
        self.assertEqual(got, {("kissing", 28.0, 51.0): {"captions": 0.68},
                               ("gore", 51.0, 90.0): {"captions": 0.765}})  # normalise trims the overlap
        self.assertEqual(doc["ranges"][0]["note"], "Possible heavy kissing. Suggested by the scene description.")
        self.assertEqual(doc["scan"]["stages"]["captions"]["detail"], "5 of 5 shots described")
        # scores only: no caption words anywhere on disk
        for word in ("couch", "pool", "floor", "woman"):
            self.assertNotIn(word, raw)
        with np.load(os.path.join(work, "captions.npz"), allow_pickle=False) as z:
            self.assertEqual(sorted(z.files), sorted(list(C.CAPTION_CATEGORIES)
                                                     + ["captioned", "shot_end", "shot_scores", "shot_start"]))
            for k in z.files:
                self.assertIn(z[k].dtype.kind, "fiu", k)
            self.assertEqual(z["shot_scores"].shape, (5, 5))
        for name in os.listdir(work):
            if os.path.isfile(os.path.join(work, name)):
                with open(os.path.join(work, name), "rb") as f:
                    self.assertNotIn(b"couch", f.read())
        self.assertNotIn("captions.partial.npz", os.listdir(work))

    def test_budget(self) -> None:
        cap = C.FakeCaptioner([])
        fed = {"signals": {"frames": {"gore": {"segments": [[60, 62, 0.5]]}}}}
        with mock.patch.object(config, "CAPTION_MAX_SHOTS", 2):
            doc, _, _, _ = self.scan(S.video90(), "frames,captions", fed, captioner_factory=lambda: cap)
        self.assertEqual(cap.calls, [40.0, 60.0])  # the hot shot (50-70) + an even sample of the other four
        self.assertEqual(doc["scan"]["stages"]["captions"]["detail"], "2 of 5 shots described")

    def test_resume_every_ten_shots_recaptions_unscored_people(self) -> None:
        state = {"n": 0}
        caps = [[10, 15, "A woman is lying in bed under a quilt."]]

        class Dying(C.FakeCaptioner):
            def caption(self, img, t=0.0):  # type: ignore[override]
                state["n"] += 1
                if state["n"] == 13:
                    raise Interrupted("killed")
                return super().caption(img, t)

        fake_lm = L.FakeLM({"bed": {"implied": 0.9}})
        with mock.patch.object(config, "CAPTION_NO_CUTS_STEP", 5.0):
            with self.assertRaises(Interrupted):
                self.scan(S.video90(), "captions", {"signals": {}, "captionsText": caps},
                          captioner_factory=lambda: Dying(caps), lm_factory=lambda: fake_lm)
            self.assertEqual(M.loaded(), [])
            self.assertIn("captions.partial.npz", os.listdir(os.path.join(self.dir, "w")))
            self.assertEqual(fake_lm.calls, [])  # the LM pass had not started
            again = C.FakeCaptioner(caps)
            doc, raw, _, _ = self.scan(S.video90(), "captions", {"signals": {}, "captionsText": caps},
                                       captioner_factory=lambda: again, lm_factory=lambda: fake_lm)
        # shot 2 (10-15 s) was captioned before the kill but its text was never stored: captioned again
        self.assertEqual(again.calls, [12.5] + [52.5 + 5 * i for i in range(8)])
        self.assertEqual(len(fake_lm.calls), 1)
        self.assertEqual([(r["category"], r["signals"]) for r in doc["ranges"]], [("implied", {"captions": 0.765})])
        self.assertNotIn("quilt", raw)


@unittest.skipUnless(FLORENCE, "Florence-2 not available (BONIS_MODELS_DIR)")
class RealFlorenceTest(unittest.TestCase):
    def test_one_noise_frame(self) -> None:
        make, _ = M.session_factory(4, "cpu", lambda m: None, arena=False)
        cap = C.FlorenceCaptioner(S.MODELS_DIR, make)
        try:
            self.assertEqual(cap.layers, list(range(6)))
            noise = np.random.default_rng(0).integers(0, 256, (768, 768, 3), dtype=np.uint8)
            ids = cap.generate(C.preprocess(noise), max_tokens=12)
            text = cap.decoder_bpe.decode(ids)
        finally:
            cap.close()
        self.assertTrue(1 <= len(ids) <= 12)
        self.assertEqual(ids[0], 0)                       # forced BOS
        self.assertTrue(all(isinstance(i, int) and 0 <= i < 51289 for i in ids))
        self.assertIsInstance(text, str)
        self.assertTrue(text)


if __name__ == "__main__":
    unittest.main()
