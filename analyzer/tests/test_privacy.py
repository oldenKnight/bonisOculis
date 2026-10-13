"""Review A1: no network and no telemetry files from a real-model scan.

A full real-model scan (all five stages: whisper.cpp, YAMNet, nsfw classifier
+ CLIP, Qwen3 via llama.cpp, Florence-2) of the 60 s clip runs under
``strace -f -e trace=connect,socket`` with HOME, XDG_CACHE_HOME and TMPDIR
pointed at private folders. It must make zero AF_INET / AF_INET6 connect
calls and leave nothing under <HOME>/.cache/Microsoft and no mat-debug*.log /
.ses in TMPDIR. A control run of bare ONNX Runtime WITHOUT the switch shows
whether the installed build has the 1DS client at all (it does in 1.29: the
control then proves the detector sees its files). Skipped without strace,
ffmpeg or BONIS_MODELS_DIR. The private folders are deleted in ``finally``.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import config  # noqa: E402
from bonis_analyzer import privacy  # noqa: E402

STRACE = shutil.which("strace")
INET_CONNECT = re.compile(r"connect\(\d+, \{sa_family=AF_INET6?\b")
CONTROL = """
import sys, time
import numpy as np
import onnxruntime as ort
s = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
s.run(None, {s.get_inputs()[0].name: np.zeros((16000,), np.float32)})
"""


def leftovers(home: str, tmp: str) -> list:
    out = []
    ms = os.path.join(home, ".cache", "Microsoft")
    if os.path.exists(ms):
        out += [os.path.join(r, f) for r, _, fs in os.walk(ms) for f in fs] or [ms]
    for name in os.listdir(tmp):
        if name.startswith("mat-debug") or name.endswith(".ses"):
            out.append(os.path.join(tmp, name))
    return out


class SweepTest(unittest.TestCase):
    def test_switch_is_set_by_the_package(self) -> None:
        self.assertEqual(os.environ.get("ORT_DISABLE_TELEMETRY"), "1")
        with open(os.path.join(S.ROOT, "packaging", "analyzer-entry.py"), encoding="utf-8") as f:
            self.assertIn('os.environ["ORT_DISABLE_TELEMETRY"] = "1"', f.read())

    def test_sweep_removes_only_new_leftovers(self) -> None:
        d = tempfile.mkdtemp(prefix="bonis-privacy-")
        old = {k: os.environ.get(k) for k in ("XDG_CACHE_HOME", "TMPDIR")}
        try:
            os.environ["XDG_CACHE_HOME"] = os.path.join(d, "cache")
            os.environ["TMPDIR"] = os.path.join(d, "tmp")
            os.makedirs(os.environ["TMPDIR"])
            tempfile.tempdir = None
            ses = os.path.join(os.environ["TMPDIR"], ".ses")
            with open(ses, "w") as f:
                f.write("someone else's")
            before = privacy.snapshot()
            root = privacy.candidates()[0]
            os.makedirs(root)
            with open(os.path.join(root, "onnxruntime.db"), "w") as f:
                f.write("x")
            log = privacy.candidates()[1]
            with open(log, "w") as f:
                f.write("x")
            removed = privacy.sweep(before)
            self.assertEqual(sorted(removed), sorted([root, log]))
            self.assertTrue(os.path.exists(ses))  # existed before: not ours
            self.assertEqual(privacy.sweep(privacy.snapshot()), [])
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            tempfile.tempdir = None
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(STRACE and S.HAVE_FFMPEG and S.MODELS_DIR and os.path.isdir(S.MODELS_DIR),
                     "needs strace, ffmpeg and BONIS_MODELS_DIR")
class NoNetworkScanTest(unittest.TestCase):
    def private_env(self, root: str, switch: bool) -> dict:
        home, tmp = os.path.join(root, "home"), os.path.join(root, "tmp")
        os.makedirs(home, exist_ok=True)
        os.makedirs(tmp, exist_ok=True)
        env = S.cli_env({"HOME": home, "XDG_CACHE_HOME": os.path.join(home, ".cache"), "TMPDIR": tmp,
                         "BONIS_MODELS_DIR": S.MODELS_DIR})
        env.pop("ORT_DISABLE_TELEMETRY", None)
        if switch:
            env["ORT_DISABLE_TELEMETRY"] = "1"
        return env

    def strace(self, root: str, cmd: list, env: dict, timeout: float) -> tuple:
        log = os.path.join(root, "strace.txt")
        res = subprocess.run([STRACE, "-f", "-qq", "-e", "trace=connect,socket", "-o", log] + cmd, cwd=S.ANALYZER,
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        with open(log, encoding="utf-8", errors="replace") as f:
            trace = f.read()
        return res, [ln for ln in trace.splitlines() if INET_CONNECT.search(ln)]

    def test_real_scan_makes_no_inet_connection_and_leaves_no_telemetry_files(self) -> None:
        root = tempfile.mkdtemp(prefix="bonis-netgate-")
        try:
            # control: bare ONNX Runtime, no switch. Shows whether this build carries the client.
            ctl = os.path.join(root, "control")
            env = self.private_env(ctl, switch=False)
            script = os.path.join(ctl, "control.py")
            with open(script, "w", encoding="utf-8") as f:
                f.write(CONTROL)
            self.strace(ctl, [sys.executable, "-I", script, os.path.join(S.MODELS_DIR, config.YAMNET_FILE)], env, 120)
            ctl_files = leftovers(env["HOME"], env["TMPDIR"])
            import onnxruntime  # noqa: PLC0415 - version for the log only

            sys.stderr.write("\n[privacy] onnxruntime %s without the switch created: %s\n" % (
                onnxruntime.__version__, [os.path.relpath(p, ctl) for p in ctl_files] or "nothing (no 1DS client)"))

            # the real scan, all stages, through the CLI (the package sets the switch itself)
            run = os.path.join(root, "scan")
            env = self.private_env(run, switch=False)
            out = os.path.join(run, "o.bonis.json")
            cmd = [sys.executable, "-m", "bonis_analyzer", "scan", "--input", S.video60(), "--work",
                   os.path.join(run, "w"), "--out", out, "--lang", "en-US", "--threads", "2", "--device", "auto",
                   "--caption-budget", "3"]
            res, connects = self.strace(run, cmd, env, 900)
            self.assertEqual(res.returncode, 0, res.stderr.decode("utf-8", "replace")[-3000:])
            self.assertEqual(connects, [], "the scan opened network connections")
            self.assertEqual(leftovers(env["HOME"], env["TMPDIR"]), [])
            # the CLI's post-run sweep must have had nothing to do (else the switch failed and
            # the sweep only hid it)
            self.assertNotIn("telemetry files appeared", res.stderr.decode("utf-8", "replace"))
            self.assertTrue(os.path.isfile(out))
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
