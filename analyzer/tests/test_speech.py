"""Speech-to-text stage: 30 s windows with 2 s overlap and no duplicated cues,
FakeSTT through the scan (cues feed the subtitle scorer and the dialogue LM,
folded into the "speech" signal), skip when subtitles exist, --force-speech,
resume per window, whisper-cli output parsing, and one real whisper.cpp run
on 5 s of silence + sine (skipped when unavailable)."""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer import models as M  # noqa: E402
from bonis_analyzer.protocol import Interrupted, Protocol  # noqa: E402
from bonis_analyzer.scan import Scan  # noqa: E402
from bonis_analyzer.signals import lm as L  # noqa: E402
from bonis_analyzer.signals import speech as SP  # noqa: E402

TRANSCRIPT = [
    {"start": 5.0, "end": 7.0, "text": "How was school today?"},
    {"start": 28.5, "end": 29.5, "text": "(moaning)"},      # inside the 28-30 overlap: window 0 owns it
    {"start": 29.5, "end": 31.0, "text": "(moaning)"},      # inside the overlap: window 1 owns it
    {"start": 45.0, "end": 47.0, "text": "Kiss me."},
]


class WindowTest(unittest.TestCase):
    def test_window_starts(self) -> None:
        self.assertEqual(SP.window_starts(20), [0.0])
        self.assertEqual(SP.window_starts(60), [0.0, 28.0, 56.0])
        self.assertEqual(SP.window_starts(58), [0.0, 28.0])

    def test_owns_splits_the_overlap(self) -> None:
        self.assertTrue(SP.owns(0, 3, 0, 28.9))
        self.assertFalse(SP.owns(0, 3, 0, 29.0))
        self.assertTrue(SP.owns(1, 3, 28, 1.0))
        self.assertFalse(SP.owns(1, 3, 28, 0.9))
        self.assertTrue(SP.owns(2, 3, 56, 40.0))  # the last window owns everything after its start + 1

    def test_no_duplicates_across_windows(self) -> None:
        stt = SP.FakeSTT(TRANSCRIPT)
        starts = SP.window_starts(60)
        cues = []
        for k, ws in enumerate(starts):
            x = np.zeros(int(min(30, 60 - ws) * 16000), np.float32)
            cues += SP.to_cues(k, len(starts), ws, stt.transcribe(x, "en", t0=ws), 60)
        self.assertEqual([(c["start"], c["text"]) for c in cues],
                         [(5.0, "How was school today?"), (28.5, "(moaning)"), (29.5, "(moaning)"), (45.0, "Kiss me.")])

    def test_lang_code(self) -> None:
        self.assertEqual((SP.lang_code("es-MX"), SP.lang_code("en-US"), SP.lang_code(None), SP.lang_code("fr")),
                         ("es", "en", "auto", "auto"))

    def test_parse_cli_output(self) -> None:
        out = ("whisper_init: loading\n[00:00:01.000 --> 00:00:03.500]   Hola, ¿cómo estás?\n"
               "[00:01:02.250 --> 00:01:04.000]  [música]\n[00:01:05.000 --> 00:01:05.000]   \n")
        self.assertEqual(SP.parse_cli_output(out), [(1.0, 3.5, "Hola, ¿cómo estás?"), (62.25, 64.0, "[música]")])


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class SpeechStageTest(unittest.TestCase):
    def setUp(self) -> None:
        M.reset_registry()
        self.dir = os.path.join(S.tmp_root(), "speech-" + self._testMethodName)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        self.fed = S.write_json(os.path.join(self.dir, "scores.json"), {"signals": {}})

    def scan(self, video: str, stages: str = "subtitles,speech", **kw: object) -> tuple:
        work, out = os.path.join(self.dir, "w"), os.path.join(self.dir, "o.bonis.json")
        buf = io.StringIO()
        extra = {k: kw.pop(k) for k in list(kw) if k in ("force_speech", "lang_explicit", "lang")}
        Scan(S.scan_args(video, work, out, stages, self.fed, **extra), Protocol(buf), **kw).run()
        with open(out, encoding="utf-8") as f:
            doc = json.load(f)
        return doc, [json.loads(x) for x in buf.getvalue().splitlines()], work

    def test_fake_stt_feeds_the_subtitle_scorer_and_lm(self) -> None:
        stt = SP.FakeSTT(TRANSCRIPT)
        fake_lm = L.FakeLM({"kiss me": {"kissing": 0.9}})
        doc, lines, work = self.scan(S.video60(), stt_factory=lambda: stt, lm_factory=lambda: fake_lm)
        self.assertIn({"t": "stage", "stage": "subtitles", "status": "skipped"}, lines)
        self.assertIn({"t": "stage", "stage": "speech", "status": "done"}, lines)
        self.assertIn({"t": "stage", "stage": "lm", "status": "done"}, lines)
        self.assertEqual([c[0] for c in stt.calls], [0.0, 28.0, 56.0])       # three windows
        self.assertEqual([c[1] for c in stt.calls[:2]], [30.0, 30.0])
        self.assertTrue(all(c[2] == "en" for c in stt.calls))                # --lang en-US given
        self.assertTrue(any("Kiss me." in c for c in fake_lm.calls))
        self.assertNotIn("No readable subtitles were found; dialogue was not checked.", doc["scan"]["warnings"])
        cats = sorted({r["category"] for r in doc["ranges"]})
        self.assertEqual(cats, ["kissing", "sex"])
        sex = [r for r in doc["ranges"] if r["category"] == "sex"][0]
        self.assertEqual(sex["signals"], {"speech": 0.85})                   # SDH "(moaning)" from the lexicon
        self.assertEqual(sex["note"], "Possible sexual activity. Suggested by the dialogue.")
        self.assertNotIn("subtitles", sex["signals"])
        st = doc["scan"]["stages"]["speech"]
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["model"], "fake+qwen3-0.6b-q4_k_m")  # engine + the dialogue LM folded in
        self.assertEqual(st["detail"], "3 windows, 4 cues")
        with np.load(os.path.join(work, "lm.npz")) as z:
            self.assertEqual(str(z["source"]), "speech")
        self.assertEqual(sorted(os.listdir(work)), ["fusion.npz", "lm.npz", "speech.npz", "state.json"])

    def test_auto_language_when_lang_not_given(self) -> None:
        stt = SP.FakeSTT([])
        self.scan(S.video60(), stt_factory=lambda: stt, lang_explicit=False)
        self.assertTrue(all(c[2] == "auto" for c in stt.calls))

    def test_skipped_when_subtitles_exist_unless_forced(self) -> None:
        stt = SP.FakeSTT(TRANSCRIPT)
        doc, lines, _ = self.scan(S.video90(), stt_factory=lambda: stt)
        self.assertIn({"t": "stage", "stage": "speech", "status": "skipped"}, lines)
        self.assertEqual(doc["scan"]["stages"]["speech"]["detail"], "Subtitles were found.")
        self.assertEqual(stt.calls, [])
        shutil.rmtree(os.path.join(self.dir, "w"))
        doc, lines, work = self.scan(S.video90(), stt_factory=lambda: stt, force_speech=True)
        self.assertIn({"t": "stage", "stage": "speech", "status": "done"}, lines)
        self.assertEqual([c[0] for c in stt.calls], [0.0, 28.0, 56.0, 84.0])  # 90 s -> four windows
        self.assertIn("speech.npz", os.listdir(work))
        self.assertIn("subtitles.npz", os.listdir(work))   # both dialogue signals exist; the LM reads subtitles

    def test_resume_per_window(self) -> None:
        state = {"n": 0}

        class Dying(SP.FakeSTT):
            def transcribe(self, pcm, language, t0=0.0, abort=None):  # type: ignore[override]
                state["n"] += 1
                if state["n"] == 3:
                    raise Interrupted("killed")
                return super().transcribe(pcm, language, t0, abort)

        with self.assertRaises(Interrupted):
            self.scan(S.video60(), stt_factory=lambda: Dying(TRANSCRIPT))
        self.assertEqual(M.loaded(), [])
        part = S.read_state(os.path.join(self.dir, "w"))["stages"]["speech"]
        self.assertEqual((part["status"], part["progress"]), ("running", round(2 / 3, 4)))
        stt = SP.FakeSTT(TRANSCRIPT)
        doc, lines, work = self.scan(S.video60(), stt_factory=lambda: stt)
        self.assertEqual([c[0] for c in stt.calls], [56.0])              # windows 0 and 1 were checkpointed
        self.assertEqual(doc["scan"]["stages"]["speech"]["detail"], "3 windows, 4 cues")
        self.assertNotIn("speech.windows.json", os.listdir(work))       # transcript checkpoints are cleaned up

    def test_no_audio_stream(self) -> None:
        doc, lines, _ = self.scan(S.silent_video20(), stt_factory=lambda: SP.FakeSTT([]))
        self.assertIn({"t": "stage", "stage": "speech", "status": "skipped"}, lines)
        self.assertIn("This movie has no sound track; dialogue was not checked.", doc["scan"]["warnings"])


@unittest.skipUnless(S.model_file(config.WHISPER_FILE) and SP.available(), "whisper.cpp (pywhispercpp) or model missing")
class RealWhisperTest(unittest.TestCase):
    def test_five_seconds_of_silence_and_sine(self) -> None:
        stt = SP.WhisperCppSTT(S.model_file(config.WHISPER_FILE), threads=4)
        try:
            x = np.concatenate([np.zeros(32000, np.float32),
                                (0.3 * np.sin(2 * np.pi * 440 * np.arange(48000) / 16000)).astype(np.float32)])
            segs = stt.transcribe(x, "en")
        finally:
            stt.close()
        self.assertIsInstance(segs, list)
        for a, b, t in segs:
            self.assertTrue(0 <= a < b <= 30.01 and isinstance(t, str) and t)


if __name__ == "__main__":
    unittest.main()
