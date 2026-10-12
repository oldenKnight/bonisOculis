"""Speech-to-text: whisper.cpp (small q5_1) over 30 s windows of the 16 kHz
mono stream with 2 s overlap. Runs only when no subtitle track or sidecar was
found (or --force-speech). Its cues go through the SAME scorer as subtitles
(lexicon + dialogue LM); speech has no lexicon of its own.

Engines, in order: pywhispercpp (PCM arrays straight into whisper.cpp, nothing
on disk); a whisper-cli executable ($BONIS_WHISPER_CLI) fed a temporary WAV
that is deleted in ``finally``; else the stage is skipped with a warning.

Window k starts at k * (30 - 2) s. A cue from window k is kept when its start
lies in [ws + 1, ws + 29) (the halves of the overlaps it owns; the first window
owns from 0, the last to the end), so overlapping windows never duplicate it.
"""

from __future__ import annotations

import gc
import logging
import os
import re
import shutil
import subprocess
import tempfile
import wave
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .. import config
from ..pipeline.tools import popen_kwargs

log = logging.getLogger("bonis.speech")

Cue = Dict[str, Any]
Segment = Tuple[float, float, str]  # start, end (seconds, relative to the window), text


def window_starts(duration: float, window: float = config.SPEECH_WINDOW,
                  overlap: float = config.SPEECH_OVERLAP) -> List[float]:
    stride = window - overlap
    if duration <= window:
        return [0.0]
    out = []
    s = 0.0
    while s < duration - overlap:
        out.append(round(s, 3))
        s += stride
    return out


def owns(k: int, n_windows: int, ws: float, start_rel: float,
         window: float = config.SPEECH_WINDOW, overlap: float = config.SPEECH_OVERLAP) -> bool:
    """Does window k own a cue starting ``start_rel`` seconds into it?"""
    lo = 0.0 if k == 0 else overlap / 2.0
    hi = float("inf") if k == n_windows - 1 else window - overlap / 2.0
    return lo <= start_rel < hi


def clean_text(text: str) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t


def lang_code(lang: Optional[str]) -> str:
    """--lang -> whisper language code; None/empty -> "auto"."""
    if not lang:
        return "auto"
    head = lang.lower().replace("_", "-").split("-")[0]
    return head if head in ("es", "en") else "auto"


def available() -> bool:
    try:
        import pywhispercpp.model  # noqa: F401, PLC0415
    except Exception:  # noqa: BLE001
        return False
    return True


class WhisperCppSTT:
    """pywhispercpp binding; the model stays loaded for the whole stage."""

    name = "whisper.cpp"

    def __init__(self, model_path: str, threads: int = 2) -> None:
        from pywhispercpp.model import Model  # noqa: PLC0415

        if not os.path.isfile(model_path):  # never let the binding resolve a name (it would download)
            raise FileNotFoundError(model_path)
        self.threads = max(1, int(threads))
        self.model = Model(os.path.abspath(model_path), redirect_whispercpp_logs_to=None, n_threads=self.threads,
                           print_progress=False, print_realtime=False, print_timestamps=False,
                           print_special=False, no_context=True, temperature=0.0)

    def transcribe(self, pcm: np.ndarray, language: str, t0: float = 0.0,  # noqa: ARG002
                   abort: Optional[Callable[[], bool]] = None) -> List[Segment]:
        x = np.ascontiguousarray(pcm, dtype=np.float32)
        segs = self.model.transcribe(x, abort_callback=abort, language=language, n_threads=self.threads)
        out: List[Segment] = []
        for s in segs:
            text = clean_text(s.text)
            if text:
                out.append((s.t0 / 100.0, max(s.t1, s.t0 + 1) / 100.0, text))  # whisper.cpp times are 10 ms ticks
        return out

    def close(self) -> None:
        m, self.model = getattr(self, "model", None), None
        del m
        gc.collect()


_CLI_LINE = re.compile(r"^\s*\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$")


def parse_cli_output(text: str) -> List[Segment]:
    out: List[Segment] = []
    for line in text.splitlines():
        m = _CLI_LINE.match(line)
        if not m:
            continue
        g = m.groups()
        a = int(g[0]) * 3600 + int(g[1]) * 60 + float(g[2])
        b = int(g[3]) * 3600 + int(g[4]) * 60 + float(g[5])
        t = clean_text(g[6])
        if t:
            out.append((a, max(b, a + 0.01), t))
    return out


class WhisperCliSTT:
    """Fallback: the whisper.cpp command-line tool (path from settings / env).
    whisper-cli reads files only, so each window is a temporary 16-bit WAV in
    the work directory, removed in ``finally`` (docs/PLAN.md section 4)."""

    name = "whisper-cli"

    def __init__(self, exe: str, model_path: str, work: str, threads: int = 2) -> None:
        if not (exe and os.path.isfile(exe)):
            raise FileNotFoundError(exe)
        if not os.path.isfile(model_path):
            raise FileNotFoundError(model_path)
        self.exe, self.model_path, self.work, self.threads = exe, model_path, work, max(1, int(threads))

    def transcribe(self, pcm: np.ndarray, language: str, t0: float = 0.0,  # noqa: ARG002
                   abort: Optional[Callable[[], bool]] = None) -> List[Segment]:  # noqa: ARG002
        fd, wav = tempfile.mkstemp(prefix="speech-", suffix=".wav", dir=self.work)
        os.close(fd)
        try:
            pcm16 = (np.clip(pcm, -1, 1) * 32767.0).astype("<i2")
            with wave.open(wav, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(config.AUDIO_RATE)
                w.writeframes(pcm16.tobytes())
            cmd = [self.exe, "-m", self.model_path, "-f", wav, "-l", language, "-t", str(self.threads), "-np"]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                 timeout=600, **popen_kwargs())
            if res.returncode != 0:
                raise RuntimeError("whisper-cli failed: %s" % res.stderr.decode("utf-8", "replace")[-200:])
            return parse_cli_output(res.stdout.decode("utf-8", "replace"))
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass

    def close(self) -> None:
        pass


class FakeSTT:
    """Test stand-in: a fixed transcript of absolute-time cues; each window
    returns the cues that start inside it (relative times), like whisper."""

    name = "fake"

    def __init__(self, cues: Sequence[Cue] = ()) -> None:
        self.cues = sorted(({"start": float(c["start"]), "end": float(c["end"]), "text": str(c["text"])}
                            for c in cues), key=lambda c: (c["start"], c["end"]))
        self.calls: List[Tuple[float, float, str]] = []

    def transcribe(self, pcm: np.ndarray, language: str, t0: float = 0.0,
                   abort: Optional[Callable[[], bool]] = None) -> List[Segment]:  # noqa: ARG002
        dur = len(pcm) / float(config.AUDIO_RATE)
        self.calls.append((round(t0, 3), round(dur, 3), language))
        return [(c["start"] - t0, c["end"] - t0, c["text"]) for c in self.cues if t0 <= c["start"] < t0 + dur]

    def close(self) -> None:
        pass


def whisper_cli_path() -> str:
    p = os.environ.get(config.WHISPER_CLI_ENV, "")
    if p and os.path.isfile(p):
        return p
    return shutil.which("whisper-cli") or ""


def make_stt(models_dir: str, threads: int, work: str, warn: Callable[[str], None]) -> Optional[Any]:
    """The best available engine, or None (stage skipped with a warning)."""
    model = os.path.join(models_dir, config.WHISPER_FILE)
    if not os.path.isfile(model):
        warn("The speech model is missing; dialogue without subtitles was not checked.")
        return None
    if available():
        try:
            return WhisperCppSTT(model, threads)
        except Exception as e:  # noqa: BLE001
            log.warning("pywhispercpp failed to load: %s", e)
    exe = whisper_cli_path()
    if exe:
        return WhisperCliSTT(exe, model, work, threads)
    warn("Speech recognition is not installed; dialogue without subtitles was not checked.")
    return None


def to_cues(k: int, n_windows: int, ws: float, segs: Sequence[Segment], limit: float) -> List[Cue]:
    out: List[Cue] = []
    for a, b, text in segs:
        if not owns(k, n_windows, ws, a):
            continue
        s = round(ws + max(0.0, a), 3)
        e = round(min(limit, ws + max(b, a + 0.01)), 3)
        if s >= limit:
            continue
        out.append({"start": s, "end": max(e, round(s + 0.01, 3)), "text": text})
    return out
