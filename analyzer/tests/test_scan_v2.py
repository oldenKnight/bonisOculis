"""Analyzer v2 end to end: a CLI scan with all five stages on a 60 s
testsrc2+sine clip (--scores-from for every model) writes a valid, complete
skip file and a profile line; one model set at a time (registry); pause in the
speech stage; work-dir cleanliness incl. the whisper-cli temp WAV; and, with
real models, the captions stage's peak memory on the 60 s clip."""

from __future__ import annotations

import io
import json
import os
import shutil
import stat
import sys
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer import models as M  # noqa: E402
from bonis_analyzer import protocol as P  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402
from bonis_analyzer.scan import Scan  # noqa: E402
from bonis_analyzer.signals import captions as C  # noqa: E402
from bonis_analyzer.signals import lm as L  # noqa: E402
from bonis_analyzer.signals import speech as SP  # noqa: E402

FED = {
    "signals": {"frames": {"nudity": {"segments": [[3, 6, 0.9]]}, "gore": {"segments": [[50, 52, 0.3]]}}},
    "audioClasses": {"Wail, moan": {"segments": [[20, 24, 0.9]]}, "Screaming": {"segments": [[50, 53, 1.0]]}},
    "transcript": [[31.0, 33.0, "(moaning)"], [36.0, 38.0, "Kiss me."]],
    "captionsText": [[30, 40, "A man and a woman are kissing on a couch."]],
}


def load(p: str) -> dict:
    with open(p, encoding="utf-8") as f:
        return json.load(f)


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class FullScanTest(unittest.TestCase):
    def test_all_stages_complete_skip_file(self) -> None:
        d = os.path.join(S.tmp_root(), "v2-full")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        scores = S.write_json(os.path.join(d, "scores.json"), FED)
        work, out = os.path.join(d, "w"), os.path.join(d, "clip.bonis.json")
        rc, lines, raw, err = S.run_cli("scan", "--input", S.video60(), "--work", work, "--out", out, "--lang", "en-US",
                                        "--scores-from", scores, "--threads", "2", "--profile")
        self.assertEqual(rc, 0, err[-2000:])
        for ln in raw.splitlines():
            P.parse_line(ln)
        self.assertEqual(lines[-2], {"t": "done", "out": os.path.abspath(out)})
        prof = lines[-1]
        self.assertEqual(prof["t"], "profile")
        self.assertEqual(sorted(prof["stages"]), ["audio", "captions", "frames", "fusion", "lm", "output", "speech",
                                                  "subtitles"])
        for st in prof["stages"].values():
            self.assertGreaterEqual(st["wall"], 0)
            self.assertGreater(st["peakRssMB"], 0)
        self.assertEqual((prof["framesProcessed"], prof["shotsCaptioned"]), (60, 3))
        self.assertEqual(prof["windowsScored"]["speech"], 3)
        self.assertGreaterEqual(prof["windowsScored"]["audioChunks"], 6)
        stages = [(x["stage"], x["status"]) for x in lines if x["t"] == "stage" and x["status"] != "running"]
        self.assertEqual(stages, [("subtitles", "skipped"), ("speech", "done"), ("frames", "done"), ("audio", "done"),
                                  ("lm", "skipped"), ("captions", "done"), ("fusion", "done")])
        for name in ("speech", "audio", "captions"):
            self.assertTrue(any(x["t"] == "progress" and x["stage"] == name for x in lines), name)
        doc = load(out)
        res = sf.validate(doc)
        self.assertTrue(res["ok"], res["errors"])
        self.assertEqual(doc["scan"]["status"], "complete")
        self.assertEqual({k: v["status"] for k, v in doc["scan"]["stages"].items()},
                         {"subtitles": "skipped", "speech": "done", "frames": "done", "audio": "done",
                          "captions": "done", "fusion": "done"})
        got = {(r["category"], tuple(sorted(r["signals"]))) for r in doc["ranges"]}
        self.assertEqual(got, {("nudity", ("frames",)), ("sex", ("audio",)), ("sex", ("speech",)),
                               ("kissing", ("captions", "speech")), ("gore", ("audio", "frames"))})
        kiss = [r for r in doc["ranges"] if r["category"] == "kissing"][0]
        self.assertEqual(kiss["intensity"], 2)   # 0.636: band 1, +1 because two groups agree
        self.assertEqual(kiss["note"], "Possible heavy kissing. Several signals agree (dialogue, scene description).")
        # no caption or transcript text in the skip file, notes are templates
        for word in ("couch", "Kiss me", "moaning"):
            self.assertNotIn(word, json.dumps(doc))
        # work dir: state, stage arrays, blurred thumbnails; nothing else
        self.assertEqual(sorted(os.listdir(work)), ["audio.npz", "captions.npz", "frames.npz", "fusion.npz",
                                                    "speech.npz", "state.json", "thumbs"])
        self.assertEqual(sorted(os.listdir(os.path.join(work, "thumbs"))), sorted(r["id"] + ".jpg" for r in doc["ranges"]))
        self.assertEqual(sorted(os.listdir(d)), ["clip.bonis.json", "scores.json", "w"])

    def test_pause_in_speech_stage(self) -> None:
        d = os.path.join(S.tmp_root(), "v2-pause")
        shutil.rmtree(d, ignore_errors=True)
        work = os.path.join(d, "w")
        os.makedirs(work)
        scores = S.write_json(os.path.join(d, "scores.json"), FED)
        live = S.LiveCli("scan", "--input", S.video60(), "--work", work, "--out", os.path.join(d, "o.json"),
                         "--scores-from", scores, "--stages", "speech", "--lang", "en-US",
                         env={"BONIS_TEST_UNIT_DELAY": "0.6"})
        try:
            self.assertTrue(live.wait_for(lambda: any(x.get("stage") == "speech" and x["t"] == "progress"
                                                      for x in live.lines), timeout=30))
            open(os.path.join(work, "PAUSE"), "w").close()
            self.assertTrue(live.wait_for(lambda: {"t": "paused"} in live.lines, timeout=10))
            n = len([x for x in live.lines if x["t"] == "progress"])
            time.sleep(1.5)
            self.assertEqual(len([x for x in live.lines if x["t"] == "progress"]), n)
            os.remove(os.path.join(work, "PAUSE"))
            rc = live.finish(60)
        finally:
            live.kill()
        self.assertEqual(rc, 0)
        self.assertIn({"t": "resumed"}, live.lines)
        self.assertEqual(live.lines[-1]["t"], "done")


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class OneModelSetTest(unittest.TestCase):
    def test_registry_between_stages(self) -> None:
        M.reset_registry()
        d = os.path.join(S.tmp_root(), "v2-registry")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        scores = S.write_json(os.path.join(d, "scores.json"), FED)
        seen = []

        def check(kind: str, obj: object) -> object:
            seen.append((kind, M.loaded()))   # nothing may be loaded when a stage builds its model
            return obj

        stt = SP.FakeSTT([{"start": 40.0, "end": 42.0, "text": "Kiss me."}])
        Scan(S.scan_args(S.video60(), os.path.join(d, "w"), os.path.join(d, "o.json"),
                         "subtitles,frames,audio,speech,captions", scores),
             Protocol(io.StringIO()),
             lm_factory=lambda: check("lm", L.FakeLM({"kiss": {"kissing": 0.7}})),
             stt_factory=lambda: check("stt", stt),
             captioner_factory=lambda: check("cap", C.FakeCaptioner([[0, 60, "A man is kissing a woman."]]))).run()
        self.assertEqual(M.max_concurrent(), 1)
        self.assertEqual(M.loaded(), [])
        self.assertEqual([x[1] for x in seen], [[]] * len(seen))
        loads = [n for e, n, _ in M.history() if e == "load"]
        self.assertEqual(loads, ["speech", "frames", "audio", "lm", "captions", "captions-lm"])
        hist = M.history()
        for i in range(0, len(hist), 2):  # strictly load, release, load, release, ...
            self.assertEqual((hist[i][0], hist[i + 1][0], hist[i][1]), ("load", "release", hist[i + 1][1]))


Protocol = P.Protocol


class CleanlinessTest(unittest.TestCase):
    """whisper-cli is the only engine that needs a file: its temp WAV must go
    in every case (success, failure)."""

    def fake_cli(self, d: str, rc: int) -> str:
        p = os.path.join(d, "whisper-cli-%d" % rc)
        with open(p, "w", encoding="utf-8") as f:
            f.write("#!%s\nimport sys\nprint('[00:00:01.000 --> 00:00:02.500]  hello there')\nsys.exit(%d)\n"
                    % (sys.executable, rc))
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    @unittest.skipIf(os.name == "nt", "POSIX script")
    def test_whisper_cli_temp_wav_is_deleted(self) -> None:
        d = os.path.join(S.tmp_root(), "v2-wcli")
        shutil.rmtree(d, ignore_errors=True)
        work = os.path.join(d, "work")
        os.makedirs(work)
        model = os.path.join(d, "model.bin")
        open(model, "wb").close()
        x = np.zeros(16000, np.float32)
        ok = SP.WhisperCliSTT(self.fake_cli(d, 0), model, work, 2)
        self.assertEqual(ok.transcribe(x, "en"), [(1.0, 2.5, "hello there")])
        bad = SP.WhisperCliSTT(self.fake_cli(d, 1), model, work, 2)
        with self.assertRaises(RuntimeError):
            bad.transcribe(x, "en")
        self.assertEqual(os.listdir(work), [])

    def test_wav_is_an_owned_leftover(self) -> None:
        from bonis_analyzer.pipeline import checkpoint as ck

        d = os.path.join(S.tmp_root(), "v2-owned")
        shutil.rmtree(d, ignore_errors=True)
        c = ck.Checkpoint(d)
        c.open({"k": 1})
        open(os.path.join(d, "speech-abc.wav"), "wb").close()   # left by a hard kill
        c.cleanup_after_done(["speech"])
        self.assertEqual(os.listdir(d), ["state.json"])


@unittest.skipUnless(S.HAVE_FFMPEG and all(S.model_file(f) for f in config.FLORENCE_FILES.values()),
                     "Florence-2 not available (BONIS_MODELS_DIR)")
class CaptionsMemoryTest(unittest.TestCase):
    def test_captions_stage_peak_rss_under_1_2_gb(self) -> None:
        d = os.path.join(S.tmp_root(), "v2-mem")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        rc, lines, _, err = S.run_cli("scan", "--input", S.video60(), "--work", os.path.join(d, "w"), "--out",
                                      os.path.join(d, "o.json"), "--stages", "frames,captions", "--threads", "4",
                                      "--device", "cpu", "--models", S.MODELS_DIR, "--profile", "--lang", "en-US",
                                      timeout=400)
        self.assertEqual(rc, 0, err[-3000:])
        prof = lines[-1]
        sys.stderr.write("\n[memory] captions stage: %.1f MB peak, %.1f s for %d shots\n"
                         % (prof["stages"]["captions"]["peakRssMB"], prof["stages"]["captions"]["wall"],
                            prof["shotsCaptioned"]))
        self.assertEqual(prof["shotsCaptioned"], 3)          # 60 s, no cuts -> 3 shots of 20 s
        self.assertLess(prof["stages"]["captions"]["peakRssMB"], 1200.0)
        doc = load(os.path.join(d, "o.json"))
        self.assertEqual(doc["scan"]["stages"]["captions"]["model"], "florence2-base-ft-q4f16")


if __name__ == "__main__":
    unittest.main()
