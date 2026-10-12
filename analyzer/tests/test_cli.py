"""CLI end to end on a 90 s synthetic video (ffmpeg testsrc2 / color) with a
sidecar SRT and --scores-from: protocol, exit codes, valid skip file with
the right oshash, work-dir cleanliness, kill + resume, pause, merge."""

from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import fingerprint as FP  # noqa: E402
from bonis_analyzer import protocol as P  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402

SCORES = {"signals": {"frames": {"nudity": {"segments": [[34, 40, 0.92]]},
                                 "gore": {"segments": [[80, 82, 0.5]]}}}}
EXPECTED = [("nudity", 28, 51), ("sex", 51, 65), ("gore", 78, 83)]


def spans(doc: dict) -> list:
    return [(r["category"], r["start"], r["end"]) for r in doc["ranges"]]


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class CliScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.video = S.video90()
        cls.dir = os.path.join(S.tmp_root(), "cli")
        os.makedirs(cls.dir, exist_ok=True)
        cls.scores = S.write_json(os.path.join(cls.dir, "scores.json"), SCORES)

    def paths(self, name: str) -> tuple:
        work = os.path.join(self.dir, name + "-work")
        out = os.path.join(self.dir, name + ".bonis.json")
        shutil.rmtree(work, ignore_errors=True)
        if os.path.exists(out):
            os.remove(out)
        return work, out

    def scan_args(self, work: str, out: str, *extra: str) -> list:
        return ["scan", "--input", self.video, "--work", work, "--out", out, "--lang", "en-US",
                "--scores-from", self.scores, "--threads", "2"] + list(extra)

    def test_full_scan(self) -> None:
        work, out = self.paths("full")
        t0 = time.monotonic()
        rc, lines, raw, err = S.run_cli(*self.scan_args(work, out))
        elapsed = time.monotonic() - t0
        sys.stderr.write("\n[timing] 90 s synthetic scan (--scores-from): %.2f s wall\n" % elapsed)
        self.assertEqual(rc, 0, err[-2000:])
        for ln in raw.splitlines():  # every stdout line is a protocol line
            P.parse_line(ln)
        self.assertNotIn("Traceback", raw)
        self.assertEqual(lines[-1], {"t": "done", "out": os.path.abspath(out)})
        stages = [(x["stage"], x["status"]) for x in lines if x["t"] == "stage"]
        for st in [("subtitles", "done"), ("frames", "done"), ("lm", "skipped"), ("fusion", "done")]:
            self.assertIn(st, stages)
        self.assertTrue(any(x["t"] == "progress" and x["stage"] == "frames" and "eta" in x for x in lines))
        doc = load(out)
        res = sf.validate(doc)
        self.assertTrue(res["ok"], res["errors"])
        fp = FP.fingerprint(self.video)
        self.assertEqual(doc["media"]["fingerprint"]["oshash"], fp["oshash"])
        self.assertEqual(doc["media"]["fingerprint"]["size"], fp["size"])
        self.assertEqual(doc["media"]["fingerprint"]["headSha256"], fp["headSha256"])
        self.assertEqual(doc["media"]["fingerprint"]["sceneCuts"], [30, 50])
        self.assertEqual(doc["media"]["filename"], "synthetic90.mp4")
        self.assertEqual(spans(doc), EXPECTED)
        nud = doc["ranges"][0]
        self.assertEqual((nud["cutStart"], nud["cutEnd"], nud["confidence"], nud["action"]), (30, 50, 0.92, "skip"))
        self.assertEqual(doc["ranges"][1]["signals"], {"subtitles": 0.85})
        self.assertEqual(doc["scan"]["status"], "complete")
        self.assertEqual(doc["scan"]["stages"]["frames"]["status"], "done")
        self.assertEqual(doc["scan"]["levels"]["language"], "off")
        self.assertEqual(doc["language"], "en-US")
        for r in doc["ranges"]:
            self.assertNotIn("moaning", r["note"].lower())  # notes are templates, never dialogue
        # work dir: only state, stage arrays and blurred thumbnails remain
        self.assertEqual(sorted(os.listdir(work)), ["frames.npz", "fusion.npz", "state.json", "subtitles.npz", "thumbs"])
        self.assertEqual(sorted(os.listdir(os.path.join(work, "thumbs"))), sorted(r["id"] + ".jpg" for r in doc["ranges"]))
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith(".tmp")], [])

    def test_language_level_and_spanish_notes(self) -> None:
        work, out = self.paths("lang")
        rc, lines, _, err = S.run_cli(*self.scan_args(work, out, "--levels", '{"language": "strict", "gore": "off"}'))
        self.assertEqual(rc, 0, err[-2000:])
        doc = load(out)
        self.assertEqual(spans(doc), [("nudity", 28, 51), ("sex", 51, 65), ("language", 69.5, 72.5)])
        self.assertEqual(doc["ranges"][2]["action"], "mute")
        rc, lines, _, _ = S.run_cli(*self.scan_args(work, out, "--lang", "es-MX"))
        self.assertEqual(rc, 0)
        doc = load(out)
        self.assertTrue(doc["ranges"][0]["note"].startswith("Posible desnudez"))

    def test_kill_mid_frames_then_resume(self) -> None:
        work, out = self.paths("resume")
        env = {"BONIS_TEST_FRAME_DELAY": "0.04"}
        live = S.LiveCli(*self.scan_args(work, out), env=env)
        try:
            ok = live.wait_for(lambda: (S.read_state(work).get("stages", {}).get("frames", {}).get("resumeAt") or 0) >= 30,
                               timeout=30)
            self.assertTrue(ok, "frames checkpoint never reached 30 s")
            live.proc.send_signal(signal.SIGKILL)
        finally:
            live.kill()
        st = S.read_state(work)["stages"]["frames"]
        resume_at = st["resumeAt"]
        self.assertEqual(st["status"], "running")
        self.assertIn(resume_at, (30.0, 60.0))
        self.assertFalse(os.path.exists(out))
        rc, lines, _, err = S.run_cli(*self.scan_args(work, out))
        self.assertEqual(rc, 0, err[-2000:])
        self.assertIn({"t": "stage", "stage": "frames", "status": "running", "resumeAt": resume_at}, lines)
        st = S.read_state(work)["stages"]["frames"]
        self.assertEqual(st["firstFrameThisRun"], resume_at)           # the done part was not re-scanned
        self.assertEqual(st["framesThisRun"], 90 - int(resume_at))
        # identical result to an uninterrupted scan
        work2, out2 = self.paths("noresume")
        rc, _, _, _ = S.run_cli(*self.scan_args(work2, out2))
        self.assertEqual(rc, 0)
        a, b = load(out), load(out2)
        self.assertEqual(a["ranges"], b["ranges"])
        self.assertEqual(a["media"]["fingerprint"], b["media"]["fingerprint"])

    def test_sigterm_is_resumable_exit_4(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX signal")
        work, out = self.paths("term")
        live = S.LiveCli(*self.scan_args(work, out), env={"BONIS_TEST_FRAME_DELAY": "0.04"})
        try:
            self.assertTrue(live.wait_for(lambda: any(x.get("stage") == "frames" and x["t"] == "progress"
                                                      for x in live.lines), timeout=30))
            live.proc.send_signal(signal.SIGTERM)
            rc = live.finish(30)
        finally:
            live.kill()
        self.assertEqual(rc, P.EXIT_INTERRUPTED)
        self.assertEqual(live.lines[-1]["t"], "error")
        self.assertEqual(live.lines[-1]["code"], 4)
        self.assertNotIn(b"Traceback", live.stderr)

    def test_pause_file(self) -> None:
        work, out = self.paths("pause")
        os.makedirs(work)
        pause = os.path.join(work, "PAUSE")
        open(pause, "w").close()
        live = S.LiveCli(*self.scan_args(work, out), env={"BONIS_TEST_FRAME_DELAY": "0.01"})
        try:
            self.assertTrue(live.wait_for(lambda: {"t": "paused"} in live.lines, timeout=30))
            time.sleep(1.5)
            self.assertIsNone(live.proc.poll())
            frames_progress = [x for x in live.lines if x["t"] == "progress" and x["stage"] == "frames"]
            self.assertLessEqual(len(frames_progress), 1)
            os.remove(pause)
            rc = live.finish(60)
        finally:
            live.kill()
        self.assertEqual(rc, 0)
        self.assertEqual(sum(1 for x in live.lines if x == {"t": "paused"}), 1)
        self.assertIn({"t": "resumed"}, live.lines)
        self.assertEqual(live.lines[-1]["t"], "done")

    def test_rescan_keeps_parent_edits(self) -> None:
        work, out = self.paths("merge")
        rc, _, _, _ = S.run_cli(*self.scan_args(work, out))
        self.assertEqual(rc, 0)
        doc = load(out)
        doc["ranges"][0]["review"] = "rejected"
        doc["ranges"].append(sf.new_range({"id": "rmanual01", "start": 5, "end": 9, "category": "other",
                                            "locked": True, "review": "approved"}))
        with open(out, "w", encoding="utf-8") as f:
            f.write(sf.to_json(doc))
        rc, _, _, err = S.run_cli(*self.scan_args(work, out))
        self.assertEqual(rc, 0, err[-2000:])
        new = load(out)
        self.assertTrue(sf.validate(new)["ok"])
        self.assertEqual(new["id"], doc["id"])
        byid = {r["id"]: r for r in new["ranges"]}
        self.assertEqual(byid["rmanual01"]["locked"], True)
        self.assertEqual(byid[doc["ranges"][0]["id"]]["review"], "rejected")
        self.assertEqual(sum(1 for r in new["ranges"] if r["category"] == "nudity"), 1)  # not re-created
        self.assertEqual(new["history"][-1]["event"], "scanned")

    def test_corrupt_existing_file_is_moved_aside(self) -> None:
        work, out = self.paths("corrupt")
        with open(out, "w") as f:
            f.write("{ not json")
        rc, _, _, _ = S.run_cli(*self.scan_args(work, out))
        self.assertEqual(rc, 0)
        self.assertTrue(sf.validate(load(out))["ok"])
        aside = [n for n in os.listdir(self.dir) if n.startswith("corrupt.bonis.json.corrupt-")]
        self.assertEqual(len(aside), 1)
        os.remove(os.path.join(self.dir, aside[0]))


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class CliErrorsTest(unittest.TestCase):
    def check_error(self, code: int, *args: str, env: dict = None) -> dict:
        rc, lines, raw, err = S.run_cli(*args, env=env)
        self.assertEqual(rc, code, raw + err[-1500:])
        self.assertNotIn("Traceback", raw)
        self.assertEqual(len(lines), len(raw.splitlines()))
        self.assertEqual(lines[-1]["t"], "error")
        self.assertEqual(lines[-1]["code"], code)
        return lines[-1]

    def test_bad_input(self) -> None:
        d = os.path.join(S.tmp_root(), "err")
        os.makedirs(d, exist_ok=True)
        base = ["--work", os.path.join(d, "w"), "--out", os.path.join(d, "o.json")]
        self.check_error(2, "scan", "--input", os.path.join(d, "nope.mkv"), *base)
        self.check_error(2, "scan", "--input", S.video90(), "--levels", "{bad", *base)
        self.check_error(2, "scan", "--input", S.video90(), "--levels", '{"nudity": "max"}', *base)
        self.check_error(2, "scan", "--input", S.video90(), "--stages", "frames,telepathy", *base)
        self.check_error(2, "scan", "--bogus")
        self.check_error(2, "frobnicate")
        self.check_error(2)

    def test_model_missing(self) -> None:
        d = os.path.join(S.tmp_root(), "nomodels")
        os.makedirs(os.path.join(d, "models"), exist_ok=True)
        err = self.check_error(3, "scan", "--input", S.video90(), "--work", os.path.join(d, "w"), "--out",
                               os.path.join(d, "o.json"), "--stages", "frames", "--models", os.path.join(d, "models"))
        self.assertIn("not found", err["msg"])

    def test_version_and_probe(self) -> None:
        rc, lines, _, _ = S.run_cli("version")
        self.assertEqual(rc, 0)
        self.assertEqual(lines[0]["t"], "version")
        self.assertIn("onnxruntime", lines[0])
        rc, lines, _, _ = S.run_cli("probe", "--input", S.video90())
        self.assertEqual(rc, 0)
        m = lines[0]
        self.assertEqual((m["t"], m["video"]["width"]), ("probe", 320))
        self.assertAlmostEqual(m["keyframeInterval"], 2.0, delta=0.5)
        self.assertEqual(m["fingerprint"]["oshash"], FP.oshash(S.video90()))


class ProtocolTest(unittest.TestCase):
    def test_lines(self) -> None:
        import io

        buf = io.StringIO()
        p = P.Protocol(buf, min_interval=10)
        p.progress("frames", 0.1, 600)
        p.progress("frames", 0.11, 590)   # throttled
        p.progress("frames", 0.2, 500)    # big step: emitted
        p.stage("frames", "done")
        p.warn("Something to know")
        p.paused()
        p.done("/x/y.bonis.json")
        p.error(5, "boom")
        lines = [P.parse_line(x) for x in buf.getvalue().splitlines()]
        self.assertEqual(lines[0], {"t": "progress", "stage": "frames", "p": 0.1, "eta": 600})
        self.assertEqual([x["t"] for x in lines], ["progress", "progress", "stage", "warn", "paused", "done", "error"])
        self.assertEqual(p.warnings, ["Something to know"])
        with self.assertRaises(ValueError):
            P.parse_line('{"t": "mystery"}')

    def test_exit_codes(self) -> None:
        self.assertEqual((P.EXIT_OK, P.EXIT_BAD_INPUT, P.EXIT_MODEL_MISSING, P.EXIT_INTERRUPTED, P.EXIT_INTERNAL),
                         (0, 2, 3, 4, 5))
        self.assertEqual(P.ModelMissing("x").code, 3)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(S.HAVE_FFMPEG and S.MODELS_DIR and os.path.isdir(S.MODELS_DIR), "BONIS_MODELS_DIR not set")
class RealModelScanTest(unittest.TestCase):
    """The real pipeline once on a 4 s random-noise clip: one NudeNet batch, one
    CLIP batch, at most one LM window. Checks the code path, not accuracy."""

    def test_noise_clip(self) -> None:
        d = os.path.join(S.tmp_root(), "real")
        os.makedirs(d, exist_ok=True)
        v = os.path.join(d, "noise.mp4")
        S.ffmpeg("-f", "lavfi", "-i", "nullsrc=s=320x180:r=5:d=4,geq=random(1)*255:128:128", "-c:v", "libx264",
                 "-preset", "ultrafast", "-pix_fmt", "yuv420p", v)
        with open(os.path.join(d, "noise.en.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:01,000 --> 00:00:03,000\nPass the salt, please.\n")
        work, out = os.path.join(d, "w"), os.path.join(d, "noise.bonis.json")
        t0 = time.monotonic()
        rc, lines, _, err = S.run_cli("scan", "--input", v, "--work", work, "--out", out, "--lang", "en-US",
                                      "--threads", "2", "--device", "auto", "--models", S.MODELS_DIR, timeout=300)
        sys.stderr.write("\n[timing] real-model scan of a 4 s noise clip: %.2f s wall\n" % (time.monotonic() - t0))
        self.assertEqual(rc, 0, err[-3000:])
        doc = load(out)
        self.assertTrue(sf.validate(doc)["ok"])
        self.assertEqual(doc["scan"]["stages"]["frames"]["model"], "nudenet-320n+clip-vit-b32-int8")
        self.assertEqual(doc["scan"]["status"], "complete")
        self.assertEqual(sorted(n for n in os.listdir(work) if n != "thumbs")[-1], "subtitles.npz")
        stages = {(x["stage"], x["status"]) for x in lines if x["t"] == "stage"}
        self.assertTrue(("lm", "done") in stages or ("lm", "skipped") in stages)
