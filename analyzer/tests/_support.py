"""Shared helpers for analyzer tests: synthetic media (ffmpeg lavfi only),
CLI runner, protocol parsing. No real-world media, ever (brief 8.1)."""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ANALYZER = os.path.dirname(HERE)
ROOT = os.path.dirname(ANALYZER)
SUBS = os.path.join(ROOT, "spec", "fixtures", "subtitles")
if ANALYZER not in sys.path:
    sys.path.insert(0, ANALYZER)

MODELS_DIR = os.environ.get("BONIS_MODELS_DIR", "")
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

_TMP: Optional[str] = None
_CACHE: Dict[str, str] = {}


def tmp_root() -> str:
    global _TMP
    if _TMP is None:
        _TMP = tempfile.mkdtemp(prefix="bonis-test-")
        atexit.register(shutil.rmtree, _TMP, True)
    return _TMP


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y"] + list(args), check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


SIDE_SRT = """1
00:00:05,000 --> 00:00:07,000
Hello, how was school today?

2
00:01:01,000 --> 00:01:03,500
[moaning]

3
00:01:10,000 --> 00:01:12,000
What the fuck is this?
"""


def video90() -> str:
    """90 s, 320x180 @ 10 fps: testsrc2 0-30, solid blue 30-50, testsrc2 50-90
    (scene cuts at 30 and 50) + a sine tone, with a sidecar English SRT.
    Built once per test run in a private temp dir."""
    if "v90" in _CACHE:
        return _CACHE["v90"]
    d = os.path.join(tmp_root(), "media")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "synthetic90.mp4")
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=30",
           "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=10:duration=20",
           "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=40",
           "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
           "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
           "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-shortest", p)
    with open(os.path.join(d, "synthetic90.en.srt"), "w", encoding="utf-8") as f:
        f.write(SIDE_SRT)
    _CACHE["v90"] = p
    return p


def write_json(path: str, obj: Any) -> str:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    return path


def cli_cmd(*args: str) -> List[str]:
    return [sys.executable, "-m", "bonis_analyzer"] + list(args)


def cli_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = ANALYZER + os.pathsep + env.get("PYTHONPATH", "")
    env["BONIS_LOG"] = "INFO"
    env.update(extra or {})
    return env


def run_cli(*args: str, env: Optional[Dict[str, str]] = None, timeout: float = 120) -> Tuple[int, List[Dict[str, Any]], str, str]:
    """Run the CLI; returns (exit code, parsed stdout JSON lines, raw stdout, stderr)."""
    res = subprocess.run(cli_cmd(*args), cwd=ANALYZER, env=cli_env(env), stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=timeout)
    out = res.stdout.decode("utf-8")
    lines = [json.loads(ln) for ln in out.splitlines() if ln.startswith("{")]
    return res.returncode, lines, out, res.stderr.decode("utf-8", "replace")


class LiveCli:
    """A CLI process whose stdout lines are collected by a thread."""

    def __init__(self, *args: str, env: Optional[Dict[str, str]] = None) -> None:
        self.proc = subprocess.Popen(cli_cmd(*args), cwd=ANALYZER, env=cli_env(env), stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        self.lines: List[Dict[str, Any]] = []
        self.stderr = b""
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()
        self._e = threading.Thread(target=self._read_err, daemon=True)
        self._e.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            try:
                self.lines.append(json.loads(raw.decode("utf-8")))
            except ValueError:
                self.lines.append({"t": "<unparsable>", "raw": raw.decode("utf-8", "replace")})

    def _read_err(self) -> None:
        assert self.proc.stderr is not None
        self.stderr = self.proc.stderr.read()

    def wait_for(self, pred: Any, timeout: float = 30.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if pred():
                return True
            if self.proc.poll() is not None and not pred():
                time.sleep(0.05)
                return bool(pred())
            time.sleep(0.02)
        return False

    def finish(self, timeout: float = 60.0) -> int:
        rc = self.proc.wait(timeout=timeout)
        self._t.join(timeout=5)
        self._e.join(timeout=5)
        for st in (self.proc.stdout, self.proc.stderr):
            if st is not None:
                st.close()
        return rc

    def kill(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.finish(10)
        except Exception:  # noqa: BLE001
            pass


def read_state(work: str) -> Dict[str, Any]:
    try:
        with open(os.path.join(work, "state.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def gray_frame(cmd_tail: List[str], w: int = 160) -> np.ndarray:
    """Decode one frame to grayscale via a pipe (nothing written to disk)."""
    res = subprocess.run(["ffmpeg", "-nostdin", "-v", "error"] + cmd_tail + ["-frames:v", "1", "-f", "rawvideo",
                                                                           "-pix_fmt", "gray", "pipe:1"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    a = np.frombuffer(res.stdout, dtype=np.uint8)
    return a.reshape(-1, w).astype(np.float64)


def laplacian_var(img: np.ndarray) -> float:
    lap = (-4 * img[1:-1, 1:-1] + img[:-2, 1:-1] + img[2:, 1:-1] + img[1:-1, :-2] + img[1:-1, 2:])
    return float(lap.var())


def _clip(key: str, name: str, *args: str) -> str:
    if key in _CACHE:
        return _CACHE[key]
    d = os.path.join(tmp_root(), "media-" + key)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name)
    ffmpeg(*args, p)
    _CACHE[key] = p
    return p


def video60() -> str:
    """60 s testsrc2 (320x180 @ 10 fps) + 440 Hz sine, NO subtitles (speech runs)."""
    return _clip("v60", "testsrc60.mp4",
                 "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=60",
                 "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
                 "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-shortest")


def flicker90() -> str:
    """90 s, 320x180 @ 10 fps, no audio: a checkerboard that inverts on every frame (a steady,
    large frame-to-frame difference, like grain or fast motion) over a dark / light / dark
    background with real cuts at 30 and 50. ffmpeg's scene score for the second frame after a
    seek is ~0.33 here (its previous difference is zero): the phantom cut of review B5."""
    return _clip("flk90", "flicker90.mp4", "-f", "lavfi", "-i",
                 "nullsrc=s=320x180:r=10:d=90,format=gray,"
                 "geq=lum='if(between(T,30,49.99),200,60)+40*mod(floor(X/32)+floor(Y/32)+N,2)'",
                 "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-pix_fmt", "yuv420p")


def sine_silence30() -> str:
    """30 s: grey picture; sound = sine 0-10 s, silence 10-20 s, sine 20-30 s."""
    return _clip("ss30", "sine-silence30.mp4",
                 "-f", "lavfi", "-i", "color=c=gray:size=160x90:rate=5:duration=30",
                 "-f", "lavfi", "-i", "aevalsrc='0.4*sin(2*PI*440*t)*(lt(t,10)+gte(t,20))':s=16000:d=30",
                 "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest")


def silent_video20() -> str:
    """20 s video without any audio stream."""
    return _clip("na20", "noaudio20.mp4", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5:duration=20",
                 "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")


def scan_args(video: str, work: str, out: str, stages: str, scores: Optional[str] = None, **kw: Any) -> Any:
    """argparse-like namespace for in-process Scan runs."""
    import argparse

    ns = argparse.Namespace(input=video, work=work, out=out, lang="en-US", levels=None, stages=stages, threads=2,
                            device="cpu", priority="normal", models=None, scores_from=scores, restart=False,
                            force_speech=False, profile=False, whisper_cli=None, lang_explicit=True)
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


def model_file(name: str) -> str:
    """Path of a real model file in $BONIS_MODELS_DIR, or "" when unavailable."""
    if not MODELS_DIR:
        return ""
    p = os.path.join(MODELS_DIR, name)
    return p if os.path.isfile(p) else ""
