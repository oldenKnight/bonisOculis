"""Decode (single pass, cuts, resume pre-roll, hwaccel fallback), checkpoint
store, PAUSE polling, blurred thumbnails."""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer.pipeline import checkpoint as ck  # noqa: E402
from bonis_analyzer.pipeline import decode, probe, thumbs  # noqa: E402
from bonis_analyzer.protocol import BadInput  # noqa: E402


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class DecodeTest(unittest.TestCase):
    def test_probe(self) -> None:
        m = probe.probe(S.video90())
        self.assertAlmostEqual(m["duration"], 90.0, delta=0.2)
        self.assertEqual((m["video"]["width"], m["video"]["height"]), (320, 180))
        self.assertEqual(m["subtitles"], [])
        with self.assertRaises(BadInput):
            probe.probe(os.path.join(S.tmp_root(), "missing.mp4"))
        junk = os.path.join(S.tmp_root(), "junk.mp4")
        with open(junk, "wb") as f:
            f.write(b"\0" * 1000)
        with self.assertRaises(BadInput):
            probe.probe(junk)

    def test_frames_and_cuts_one_pass(self) -> None:
        d = decode.Decoder(S.video90(), 320, 180)
        ts = []
        for t, fr in d:
            ts.append(t)
            self.assertEqual(fr.shape, (180, 320, 3))
            self.assertEqual(fr.dtype, np.uint8)
        self.assertEqual(ts, [float(i) for i in range(90)])
        self.assertEqual(d.sorted_cuts(), [30.0, 50.0])
        self.assertIsNone(d.proc)

    def test_resume_with_preroll_sees_cut_at_resume_point(self) -> None:
        d = decode.Decoder(S.video90(), 320, 180, start_at=28.0, skip_before=30.0)
        ts = [t for t, _ in d]
        self.assertEqual(ts[0], 30.0)
        self.assertEqual(len(ts), 60)
        self.assertEqual(d.sorted_cuts(), [30.0, 50.0])

    def test_resume_seek_adds_no_phantom_cut(self) -> None:
        """Review B5: after a pre-roll seek the scene detector's first comparison is against
        nothing and fires on grain/motion; cuts before the resume point must be dropped."""
        v = S.flicker90()
        full = decode.Decoder(v, 320, 180)
        n = sum(1 for _ in full)
        self.assertEqual(n, 90)
        whole = full.sorted_cuts()
        self.assertIn(30.0, whole)
        self.assertIn(50.0, whole)
        for start, resume in ((28.0, 30.0), (58.0, 60.0), (38.0, 40.0)):
            d = decode.Decoder(v, 320, 180, start_at=start, skip_before=resume)
            self.assertEqual([t for t, _ in d][0], resume)
            self.assertEqual(d.sorted_cuts(), [c for c in whole if c >= resume], (start, d.cuts))

    def test_early_close_kills_ffmpeg(self) -> None:
        d = decode.Decoder(S.video90(), 320, 180)
        it = iter(d)
        next(it)
        proc = d.proc
        it.close()
        self.assertIsNotNone(proc)
        self.assertIsNotNone(proc.poll())

    def test_hwaccel_failure_falls_back(self) -> None:
        calls = []

        def factory(path, w, h, start_at=0.0, hwaccel=True, threads=0):
            calls.append(hwaccel)
            cmd = decode.build_command(path, w, h, start_at=start_at, hwaccel=False, threads=threads)
            if hwaccel:  # simulate a broken accelerator
                cmd[cmd.index("-i")] = "-no-such-option"
            return cmd

        d = decode.Decoder(S.video90(), 320, 180, command_factory=factory)
        self.assertEqual(len([t for t, _ in d]), 90)
        self.assertEqual(calls, [True, False])
        self.assertFalse(d.used_hwaccel)

    def test_command_shape(self) -> None:
        cmd = decode.build_command("in.mkv", 1920, 800, start_at=12.5)
        s = " ".join(cmd)
        self.assertLess(cmd.index("-hwaccel"), cmd.index("-ss"))
        self.assertLess(cmd.index("-ss"), cmd.index("-i"))
        self.assertIn("[0:v:0]split=2[a][b];[a]fps=1,scale=320:134[fr];[b]scale=160:-2,select='gt(scene,0.3)',showinfo[sc]", s)
        self.assertIn("-f rawvideo -pix_fmt rgb24 pipe:1", s)
        self.assertIn("-f null -", s)
        self.assertEqual(decode.frame_size(1920, 1080), (320, 180))
        self.assertEqual(decode.frame_size(720, 576), (320, 256))


class CheckpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.work = os.path.join(self.tmp.name, "work")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_resume_and_fingerprint_mismatch(self) -> None:
        c = ck.Checkpoint(self.work)
        self.assertFalse(c.open({"oshash": "a"}))
        c.save_arrays("frames", {"nudity": np.arange(5, dtype=np.float64), "cuts": np.array([1.5])})
        c.set_stage("frames", "running", resumeAt=30.0, progress=0.3)
        c2 = ck.Checkpoint(self.work)
        self.assertTrue(c2.open({"oshash": "a"}))
        self.assertEqual(c2.stage("frames")["resumeAt"], 30.0)
        arr = c2.load_arrays("frames")
        self.assertEqual(arr["nudity"].dtype, np.float32)
        self.assertEqual(arr["cuts"].dtype, np.float64)
        c3 = ck.Checkpoint(self.work)
        self.assertFalse(c3.open({"oshash": "b"}))  # different input: start over
        self.assertEqual(sorted(os.listdir(self.work)), ["state.json"])

    def test_restart_wipes_but_keeps_pause(self) -> None:
        c = ck.Checkpoint(self.work)
        c.open({"k": 1})
        c.save_arrays("subtitles", {"sex": np.zeros(3)})
        os.makedirs(os.path.join(self.work, "thumbs"))
        open(os.path.join(self.work, "PAUSE"), "w").close()
        ck.Checkpoint(self.work).open({"k": 1}, restart=True)
        self.assertEqual(sorted(os.listdir(self.work)), ["PAUSE", "state.json"])

    def test_refuses_foreign_directory(self) -> None:
        os.makedirs(self.work)
        open(os.path.join(self.work, "holiday-video.mp4"), "w").close()
        with self.assertRaises(BadInput):
            ck.Checkpoint(self.work).open({"k": 1})
        self.assertTrue(os.path.exists(os.path.join(self.work, "holiday-video.mp4")))

    def test_cleanup_after_done(self) -> None:
        c = ck.Checkpoint(self.work)
        c.open({"k": 1})
        for n in ("frames", "subtitles", "fusion"):
            c.save_arrays(n, {"x": np.zeros(2)})
        c.write_json("subtitles.cues.json", [{"text": "dialogue"}])
        os.makedirs(os.path.join(self.work, "thumbs"))
        open(os.path.join(self.work, "frames.npz.tmp"), "w").close()
        c.cleanup_after_done(["frames", "subtitles", "lm", "fusion"])
        self.assertEqual(sorted(os.listdir(self.work)),
                         ["frames.npz", "fusion.npz", "state.json", "subtitles.npz", "thumbs"])

    def test_pauser(self) -> None:
        c = ck.Checkpoint(self.work)
        c.open({"k": 1})
        events = []

        class P:
            def paused(self) -> None:
                events.append("paused")

            def resumed(self) -> None:
                events.append("resumed")

        pause = os.path.join(self.work, "PAUSE")
        open(pause, "w").close()
        threading.Timer(0.3, os.remove, args=(pause,)).start()
        flushed = []
        p = ck.Pauser(c, P(), interval=0.05, on_pause=lambda: flushed.append(1))
        t0 = time.monotonic()
        p.check()
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)
        self.assertEqual(events, ["paused", "resumed"])
        self.assertEqual(flushed, [1])
        p.check()
        self.assertEqual(events, ["paused", "resumed"])


class FakeModel:
    instances = 0

    def __init__(self) -> None:
        FakeModel.instances += 1
        self.closed = False
        self.name = "fake"

    def score(self, x: int) -> int:
        assert not self.closed
        return x * 2

    def close(self) -> None:
        self.closed = True


class PauseReleaseTest(unittest.TestCase):
    """Review B6: a long PAUSE releases the stage's model set; resume reloads it."""

    def setUp(self) -> None:
        from bonis_analyzer import models as M

        self.M = M
        M.reset_registry()
        self.work = os.path.join(S.tmp_root(), "pause-release-" + self._testMethodName)
        c = ck.Checkpoint(self.work)
        c.open({"k": 1})
        self.ckpt = c
        self.pause = os.path.join(self.work, "PAUSE")

    def test_slot_release_and_lazy_reload(self) -> None:
        first = FakeModel()
        self.M.register("audio", "fake")
        slot = self.M.ModelSlot("audio", first, FakeModel)
        self.assertEqual(slot.score(2), 4)
        slot.release()
        self.assertTrue(first.closed)
        self.assertEqual(self.M.loaded(), [])
        self.assertFalse(slot.loaded)
        self.assertEqual(slot.score(3), 6)          # used again without an explicit reload
        self.assertEqual(self.M.loaded(), ["audio"])
        self.assertEqual((slot.releases, slot.reloads), (1, 1))
        slot.close()
        self.M.release("audio")
        from bonis_analyzer.protocol import ModelMissing

        gone = self.M.ModelSlot("x", FakeModel(), lambda: None)  # model file vanished during the pause
        gone.release()
        with self.assertRaises(ModelMissing):
            gone.reload()

    def test_long_pause_releases_short_pause_keeps(self) -> None:
        seen = []
        for hold, expect_release in ((0.25, False), (0.6, True)):
            self.M.reset_registry()
            self.M.register("frames", "fake")
            slot = self.M.ModelSlot("frames", FakeModel(), FakeModel)
            p = ck.Pauser(self.ckpt, None, interval=0.05, release_after=0.4)
            p.slot = slot
            open(self.pause, "w").close()
            during: list = []
            probe_t = threading.Timer(hold - 0.05, lambda: during.append(self.M.loaded()))
            probe_t.start()
            threading.Timer(hold, os.remove, args=(self.pause,)).start()
            p.check()
            probe_t.join()
            self.assertEqual(during[0], [] if expect_release else ["frames"], hold)
            self.assertEqual(self.M.loaded(), ["frames"])  # loaded again after the pause
            self.assertEqual((slot.releases, slot.reloads), (1, 1) if expect_release else (0, 0))
            self.assertEqual(slot.score(1), 2)
            self.assertLessEqual(self.M.max_concurrent(), 1)
            seen.append([e for e, n, _ in self.M.history() if n == "frames"])
        self.assertEqual(seen, [["load"], ["load", "release", "load"]])

    @unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
    def test_scan_releases_frames_models_while_paused(self) -> None:
        import io
        from unittest import mock

        from bonis_analyzer import config
        from bonis_analyzer.protocol import Protocol
        from bonis_analyzer.scan import Scan

        d = os.path.join(S.tmp_root(), "pause-scan")
        os.makedirs(d, exist_ok=True)
        scores = S.write_json(os.path.join(d, "scores.json"), {"signals": {"frames": {"gore": [0.0] * 5 + [0.9] * 5}}})
        work, out = os.path.join(d, "w"), os.path.join(d, "o.bonis.json")
        pause = os.path.join(work, "PAUSE")
        buf = io.StringIO()
        seen: dict = {}

        def driver() -> None:
            end = time.monotonic() + 30
            while time.monotonic() < end and "frames" not in self.M.loaded():
                time.sleep(0.02)
            open(pause, "w").close()
            while time.monotonic() < end and self.M.loaded():  # wait for the release
                time.sleep(0.05)
            seen["during"] = self.M.loaded()
            time.sleep(0.3)
            os.remove(pause)

        self.M.reset_registry()
        t = threading.Thread(target=driver, daemon=True)
        with mock.patch.object(config, "PAUSE_RELEASE_AFTER", 0.5), \
                mock.patch.dict(os.environ, {"BONIS_TEST_FRAME_DELAY": "0.05"}):
            t.start()
            Scan(S.scan_args(S.video90(), work, out, "frames", scores, restart=True), Protocol(buf)).run()
        t.join(5)
        self.assertEqual(seen.get("during"), [])
        ev = [(e, n) for e, n, _ in self.M.history() if n == "frames"]
        self.assertEqual(ev, [("load", "frames"), ("release", "frames"), ("load", "frames"), ("release", "frames")])
        self.assertEqual(self.M.max_concurrent(), 1)
        lines = buf.getvalue()
        self.assertIn('"t":"paused"', lines)
        self.assertIn('"t":"resumed"', lines)
        with open(out, encoding="utf-8") as f:
            import json

            doc = json.load(f)
        self.assertIn("gore", {r["category"] for r in doc["ranges"]})


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class ThumbsTest(unittest.TestCase):
    def test_thumbnail_is_blurred(self) -> None:
        video = S.video90()
        work = os.path.join(S.tmp_root(), "thumb-work")
        made = thumbs.make_thumbs(video, work, [{"id": "rtest0001", "start": 60.0, "end": 70.0}], 90.0)
        self.assertEqual(made, [os.path.join(work, "thumbs", "rtest0001.jpg")])
        self.assertEqual(os.listdir(os.path.join(work, "thumbs")), ["rtest0001.jpg"])
        blurred = S.gray_frame(["-i", made[0]])
        clear = S.gray_frame(["-ss", "65.000", "-i", video, "-vf", "scale=160:-2"])  # in memory only
        self.assertEqual(blurred.shape, clear.shape)
        vb, vc = S.laplacian_var(blurred), S.laplacian_var(clear)
        self.assertGreater(vc, 100.0)
        self.assertLess(vb, vc * 0.05, (vb, vc))
        # existing thumbs are kept, not rewritten
        self.assertEqual(thumbs.make_thumbs(video, work, [{"id": "rtest0001", "start": 60.0, "end": 70.0}], 90.0), [])


if __name__ == "__main__":
    unittest.main()
