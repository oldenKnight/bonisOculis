"""Audio decode pass: ffmpeg -> 16 kHz mono float32 PCM on a pipe.

    ffmpeg [-ss T] -i F -map 0:a:0 -vn -sn -dn -ac 1 -ar 16000 -f f32le pipe:1

Read in fixed-size pieces (the audio stage asks for 10 s, the speech stage
for 30 s windows), so a film's soundtrack is never held in memory and no
audio chunk ever touches disk. ``-ss`` before ``-i`` is accurate for audio
(ffmpeg decodes and discards up to T), so a resumed stage sees the same
samples at the same media times.
"""

from __future__ import annotations

import logging
import subprocess
import threading
from collections import deque
from typing import Deque, List, Optional

import numpy as np

from .. import config
from .tools import popen_kwargs, tool

log = logging.getLogger("bonis.pcm")


def build_command(path: str, start_at: float = 0.0, rate: int = config.AUDIO_RATE, threads: int = 0) -> List[str]:
    cmd = [tool("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error"]
    if threads:
        cmd += ["-threads", str(int(threads))]
    if start_at > 0:
        cmd += ["-ss", "%.3f" % start_at]
    cmd += ["-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(int(rate)),
            "-f", "f32le", "pipe:1"]
    return cmd


class PcmError(RuntimeError):
    pass


class PcmReader:
    """Sequential float32 reader over an ffmpeg pipe. ``t`` is the media time
    of the next sample to be read."""

    def __init__(self, path: str, start_at: float = 0.0, rate: int = config.AUDIO_RATE, threads: int = 0) -> None:
        self.rate = rate
        self.t = max(0.0, float(start_at))
        self._read_samples = 0
        self.start_at = self.t
        self.stderr_tail: Deque[str] = deque(maxlen=20)
        self.proc: Optional[subprocess.Popen] = subprocess.Popen(
            build_command(path, self.t, rate, threads), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL, bufsize=0, **popen_kwargs())
        self._err = threading.Thread(target=self._read_err, daemon=True)
        self._err.start()
        self.eof = False

    def _read_err(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        for raw in iter(proc.stderr.readline, b""):
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())

    def read(self, seconds: float) -> np.ndarray:
        """Up to ``seconds`` of audio (shorter only at the end of the stream)."""
        want = int(round(seconds * self.rate)) * 4
        if self.eof or self.proc is None or want <= 0:
            return np.zeros(0, dtype=np.float32)
        assert self.proc.stdout is not None
        chunks = []
        got = 0
        while got < want:
            b = self.proc.stdout.read(want - got)
            if not b:
                self.eof = True
                break
            chunks.append(b)
            got += len(b)
        data = b"".join(chunks)
        data = data[: len(data) - (len(data) % 4)]
        a = np.frombuffer(data, dtype="<f4").astype(np.float32)
        self._read_samples += a.size
        self.t = self.start_at + self._read_samples / float(self.rate)
        if self.eof:
            rc = self.proc.wait()
            self._err.join(timeout=5)
            if rc != 0 and self._read_samples == 0:
                raise PcmError("ffmpeg could not decode the audio: %s" % " | ".join(list(self.stderr_tail)[-3:]))
        return np.clip(np.nan_to_num(a, nan=0.0), -1.0, 1.0)

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
        for s in (proc.stdout, proc.stderr):
            try:
                if s is not None:
                    s.close()
            except OSError:
                pass
        self._err.join(timeout=2)

    def __enter__(self) -> "PcmReader":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
