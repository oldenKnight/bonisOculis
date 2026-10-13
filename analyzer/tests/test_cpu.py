"""CPU guard for the ggml stages (cpu.py): detection logic with the probes
monkeypatched, the scan with AVX2 patched absent and present (speech and the
dialogue/caption LM skipped with a coded warn; subtitles, frames, audio and
captions still run), and `version --cpu-features`."""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer import cpu  # noqa: E402
from bonis_analyzer import models as M  # noqa: E402
from bonis_analyzer import protocol as P  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402
from bonis_analyzer.scan import Scan  # noqa: E402
from bonis_analyzer.signals import lm as L  # noqa: E402
from bonis_analyzer.signals import speech as SP  # noqa: E402

TRANSCRIPT = [{"start": 5.0, "end": 7.0, "text": "Kiss me."}]
FED = {"signals": {"frames": {"gore": {"segments": [[10, 12, 0.9]]}}},
       "captionsText": [[0, 60, "A man and a woman are lying in bed."]]}


class DetectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop(config.CPU_ENV, None)

    def tearDown(self) -> None:
        self.env.stop()

    def feats(self, arch: str, avx2: object) -> mock._patch:
        return mock.patch.object(cpu, "features", return_value={"arch": arch, "avx2": avx2, "flags": [], "source": "t"})

    def test_x86_with_and_without_avx2(self) -> None:
        with self.feats("x86_64", True):
            self.assertTrue(cpu.has_avx2())
        with self.feats("x86_64", False):
            self.assertFalse(cpu.has_avx2())
            self.assertFalse(cpu.ggml_supported())
            r = cpu.report()
            self.assertEqual((r["ggmlStages"], r["skippedStages"]), ("skipped", ["lm", "speech"]))
        with self.feats("amd64", False):  # Windows spelling
            self.assertFalse(cpu.has_avx2())

    def test_unknown_or_arm_counts_as_supported(self) -> None:
        with self.feats("x86_64", None):  # probe failed: keep the old behaviour
            self.assertTrue(cpu.has_avx2())
        with self.feats("arm64", None):
            self.assertTrue(cpu.has_avx2())
        with self.feats("aarch64", False):
            self.assertTrue(cpu.has_avx2())

    def test_env_override(self) -> None:
        with self.feats("x86_64", True):
            with mock.patch.dict(os.environ, {config.CPU_ENV: "0"}):
                self.assertFalse(cpu.has_avx2())
                self.assertEqual(cpu.report()["override"], "BONIS_CPU_AVX2=0")
        with self.feats("x86_64", False):
            with mock.patch.dict(os.environ, {config.CPU_ENV: "1"}):
                self.assertTrue(cpu.has_avx2())

    def test_linux_flags_parsing(self) -> None:
        d = os.path.join(S.tmp_root(), "cpuinfo")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "cpuinfo")
        with open(p, "w", encoding="utf-8") as f:
            f.write("processor\t: 0\nmodel name\t: Intel(R) Core(TM) i5-2400\nflags\t\t: fpu sse4_2 avx popcnt\n\n")
        self.assertEqual(cpu._linux_flags(p), ["fpu", "sse4_2", "avx", "popcnt"])
        self.assertIsNone(cpu._linux_flags(os.path.join(d, "missing")))
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(cpu, "machine", return_value="x86_64"), \
                mock.patch.object(cpu, "_linux_flags", return_value=["fpu", "sse4_2", "avx"]):
            f = cpu.features()
            self.assertEqual((f["avx2"], f["flags"]), (False, ["avx", "sse4_2"]))
            self.assertFalse(cpu.has_avx2())

    def test_mac_and_windows_probes(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"), mock.patch.object(cpu, "machine", return_value="arm64"):
            self.assertIsNone(cpu.features()["avx2"])
            self.assertTrue(cpu.has_avx2())
        leaf7 = "RDWRFSGS TSC_THREAD_OFFSET BMI1 AVX2 SMEP BMI2"
        with mock.patch.object(sys, "platform", "darwin"), mock.patch.object(cpu, "machine", return_value="x86_64"), \
                mock.patch.object(cpu, "_sysctl", side_effect=lambda k: leaf7 if "leaf7" in k else "FPU SSE4.2 AVX1.0"):
            f = cpu.features()
            self.assertTrue(f["avx2"])
            self.assertEqual(f["flags"], ["avx", "avx2", "sse4_2"])
        with mock.patch.object(sys, "platform", "darwin"), mock.patch.object(cpu, "machine", return_value="x86_64"), \
                mock.patch.object(cpu, "_sysctl", side_effect=lambda k: "SMEP BMI1" if "leaf7" in k else "FPU AVX1.0"):
            self.assertFalse(cpu.has_avx2())
        with mock.patch.object(sys, "platform", "darwin"), mock.patch.object(cpu, "machine", return_value="x86_64"), \
                mock.patch.object(cpu, "_sysctl", return_value=None):
            self.assertTrue(cpu.has_avx2())  # unknown
        with mock.patch.object(sys, "platform", "win32"), mock.patch.object(cpu.os, "name", "nt"), \
                mock.patch.object(cpu, "machine", return_value="amd64"):
            with mock.patch.object(cpu, "_windows_avx2", return_value=False):
                self.assertFalse(cpu.has_avx2())
            with mock.patch.object(cpu, "_windows_avx2", return_value=True):
                self.assertTrue(cpu.has_avx2())
        self.assertEqual(cpu.PF_AVX2_INSTRUCTIONS_AVAILABLE, 40)


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class GuardScanTest(unittest.TestCase):
    def setUp(self) -> None:
        M.reset_registry()
        self.dir = os.path.join(S.tmp_root(), "cpu-" + self._testMethodName)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        self.fed = S.write_json(os.path.join(self.dir, "scores.json"), FED)

    def scan(self, video: str, stages: str, avx2: bool, **kw: object) -> tuple:
        work, out = os.path.join(self.dir, "w"), os.path.join(self.dir, "o.bonis.json")
        buf = io.StringIO()
        with mock.patch.object(cpu, "has_avx2", return_value=avx2):
            Scan(S.scan_args(video, work, out, stages, self.fed), P.Protocol(buf), **kw).run()
        for ln in buf.getvalue().splitlines():
            P.parse_line(ln)
        with open(out, encoding="utf-8") as f:
            doc = json.load(f)
        self.assertTrue(sf.validate(doc)["ok"])
        return doc, [json.loads(x) for x in buf.getvalue().splitlines()]

    @staticmethod
    def cpu_warns(lines: list) -> list:
        return [x for x in lines if x["t"] == "warn" and x.get("code") == "cpu-no-avx2"]

    def test_no_avx2_skips_speech_and_caption_lm(self) -> None:
        stt, lm = SP.FakeSTT(TRANSCRIPT), L.FakeLM({"bed": {"implied": 0.9}})
        doc, lines = self.scan(S.video60(), "subtitles,frames,audio,speech,captions", False,
                               stt_factory=lambda: stt, lm_factory=lambda: lm)
        self.assertEqual(stt.calls, [])
        self.assertEqual(lm.calls, [])
        warns = self.cpu_warns(lines)
        self.assertEqual([w["stage"] for w in warns], ["speech", "captions"])
        self.assertTrue(all("AVX2" in w["msg"] for w in warns))
        st = doc["scan"]["stages"]
        self.assertEqual(st["speech"]["status"], "skipped")
        self.assertIn("AVX2", st["speech"]["detail"])
        self.assertEqual({k: st[k]["status"] for k in ("frames", "audio", "captions")},
                         {"frames": "done", "audio": "done", "captions": "done"})
        self.assertEqual(doc["scan"]["status"], "complete")
        self.assertIn("gore", {r["category"] for r in doc["ranges"]})
        self.assertTrue(any("AVX2" in w for w in doc["scan"]["warnings"]))

    def test_no_avx2_skips_dialogue_lm(self) -> None:
        lm = L.FakeLM({"school": {"implied": 0.9}})
        doc, lines = self.scan(S.video90(), "subtitles,frames", False, lm_factory=lambda: lm)
        self.assertEqual(lm.calls, [])
        self.assertEqual([w["stage"] for w in self.cpu_warns(lines)], ["lm"])
        self.assertIn({"t": "stage", "stage": "lm", "status": "skipped"}, lines)
        sub = doc["scan"]["stages"]["subtitles"]
        self.assertEqual(sub["status"], "done")
        self.assertIn("AVX2", sub["detail"])
        self.assertEqual(doc["scan"]["status"], "complete")

    def test_avx2_present_runs_everything(self) -> None:
        stt, lm = SP.FakeSTT(TRANSCRIPT), L.FakeLM({"bed": {"implied": 0.9}, "kiss": {"kissing": 0.8}})
        doc, lines = self.scan(S.video60(), "subtitles,frames,audio,speech,captions", True,
                               stt_factory=lambda: stt, lm_factory=lambda: lm)
        self.assertEqual(self.cpu_warns(lines), [])
        self.assertTrue(stt.calls)
        self.assertTrue(lm.calls)
        self.assertEqual(doc["scan"]["stages"]["speech"]["status"], "done")
        self.assertIn({"t": "stage", "stage": "lm", "status": "done"}, lines)


class VersionCpuTest(unittest.TestCase):
    def test_version_cpu_features(self) -> None:
        rc, lines, raw, err = S.run_cli("version", "--cpu-features", env={config.CPU_ENV: "0"})
        self.assertEqual(rc, 0, err)
        v = lines[-1]
        self.assertEqual(v["t"], "version")
        self.assertEqual(v["cpu"]["ggmlStages"], "skipped")
        self.assertEqual(v["cpu"]["skippedStages"], ["lm", "speech"])
        self.assertIsNone(v["llamaCpp"])  # not imported without AVX2
        self.assertIn("arch", v["cpu"])
        rc, lines, _, err = S.run_cli("version", env={config.CPU_ENV: "1"})
        self.assertEqual(rc, 0, err)
        self.assertNotIn("cpu", lines[-1])

    @unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
    def test_cli_scan_warn_line_has_code(self) -> None:
        d = os.path.join(S.tmp_root(), "cpu-cli")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        scores = S.write_json(os.path.join(d, "scores.json"), {"signals": {}})
        out = os.path.join(d, "o.bonis.json")
        rc, lines, raw, err = S.run_cli("scan", "--input", S.video90(), "--work", os.path.join(d, "w"), "--out", out,
                                        "--lang", "en-US", "--stages", "subtitles,frames", "--scores-from", scores,
                                        env={config.CPU_ENV: "0"})
        self.assertEqual(rc, 0, err[-2000:])
        for ln in raw.splitlines():
            P.parse_line(ln)
        w = [x for x in lines if x["t"] == "warn" and x.get("code") == "cpu-no-avx2"]
        self.assertEqual(len(w), 1)
        self.assertEqual(w[0]["stage"], "lm")
        self.assertEqual(list(w[0])[:2], ["t", "code"])


if __name__ == "__main__":
    unittest.main()
