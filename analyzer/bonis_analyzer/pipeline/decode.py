"""One ffmpeg pass: 1 fps RGB frames on stdout + scene-cut timestamps from a
showinfo branch on stderr. Frames never touch disk.

    [0:v]split=2[a][b];
    [a]fps=1,scale=320:H[fr]            -> rawvideo rgb24 pipe:1
    [b]scale=160:-2,select='gt(scene,0.3)',showinfo[sc] -> null (pts_time on stderr)

``-hwaccel auto`` first; on failure the pass restarts without it from the
next unseen second. ``start_at`` (resume) seeks with ``-ss`` before ``-i``.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from collections import deque
from typing import Any, Callable, Deque, Iterator, List, Optional, Tuple

import numpy as np

from .. import config
from .tools import popen_kwargs, tool

log = logging.getLogger("bonis.decode")

_PTS = re.compile(r"\bpts_time:\s*(-?[0-9.]+)")


def frame_size(width: int, height: int, out_w: int = config.FRAME_WIDTH) -> Tuple[int, int]:
    """Output size for scale=out_w:H with an even H that keeps the aspect."""
    h = int(round(height * out_w / float(width) / 2.0)) * 2
    return out_w, max(2, h)


def build_command(path: str, width: int, height: int, start_at: float = 0.0, hwaccel: bool = True,
                  threads: int = 0) -> List[str]:
    w, h = frame_size(width, height)
    graph = ("[0:v:0]split=2[a][b];"
             "[a]fps=%d,scale=%d:%d[fr];"
             "[b]scale=%d:-2,select='gt(scene,%s)',showinfo[sc]"
             % (config.FRAME_FPS, w, h, config.SCENE_WIDTH, config.SCENE_THRESHOLD))
    cmd = [tool("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "info"]
    if threads:
        cmd += ["-threads", str(int(threads))]
    if hwaccel:
        cmd += ["-hwaccel", "auto"]
    if start_at > 0:
        cmd += ["-ss", "%.3f" % start_at]
    cmd += ["-i", path, "-filter_complex", graph,
            "-map", "[fr]", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
            "-map", "[sc]", "-f", "null", "-"]
    return cmd


class Decoder:
    """Iterate ``(timestamp, HxWx3 uint8)`` frames; ``cuts`` fills as it goes.

    Timestamps are media seconds (``start_at`` + frame index). Frames before
    ``skip_before`` are dropped (pre-roll used on resume). Scene cuts are
    absolute media seconds, sorted, deduplicated.
    """

    def __init__(self, path: str, width: int, height: int, start_at: float = 0.0,
                 skip_before: float = 0.0, threads: int = 0, hwaccel: bool = True,
                 command_factory: Optional[Callable[..., List[str]]] = None) -> None:
        self.path = path
        self.width, self.height = width, height
        self.w, self.h = frame_size(width, height)
        self.start_at = max(0.0, start_at)
        self.skip_before = skip_before
        self.threads = threads
        self.hwaccel = hwaccel
        self.cuts: List[float] = []
        self.proc: Optional[subprocess.Popen] = None
        self.stderr_tail: Deque[str] = deque(maxlen=40)
        self.used_hwaccel: Optional[bool] = None
        self.command_factory = command_factory or build_command
        self._lock = threading.Lock()

    # stderr reader ---------------------------------------------------------
    def _read_stderr(self, proc: subprocess.Popen, offset: float) -> None:
        assert proc.stderr is not None
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace")
            if "showinfo" in line and "pts_time" in line:
                m = _PTS.search(line)
                if m:
                    try:
                        t = round(float(m.group(1)) + offset, 3)
                    except ValueError:
                        continue
                    # the first frame after a seek has no predecessor: cuts there are not real
                    if t > 0 and (offset <= 0 or t > offset + 0.05):
                        with self._lock:
                            self.cuts.append(t)
                continue
            self.stderr_tail.append(line.rstrip())

    def sorted_cuts(self) -> List[float]:
        with self._lock:
            cs = sorted(self.cuts)
        out: List[float] = []
        for c in cs:
            if not out or c - out[-1] > config.CUT_DEDUPE:
                out.append(c)
        return out

    # one ffmpeg run ----------------------------------------------------------
    def _run(self, start_at: float, hwaccel: bool) -> Iterator[Tuple[float, np.ndarray]]:
        cmd = self.command_factory(self.path, self.width, self.height, start_at=start_at, hwaccel=hwaccel,
                                   threads=self.threads)
        log.info("decode from %.1f s (hwaccel=%s)", start_at, hwaccel)
        size = self.w * self.h * 3
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                bufsize=0, **popen_kwargs())
        self.proc = proc
        reader = threading.Thread(target=self._read_stderr, args=(proc, start_at), daemon=True)
        reader.start()
        idx = 0
        try:
            assert proc.stdout is not None
            while True:
                buf = _read_exact(proc.stdout, size)
                if buf is None:
                    break
                t = start_at + idx * (1.0 / config.FRAME_FPS)
                idx += 1
                if t < self.skip_before - 1e-6:
                    continue
                yield round(t, 3), np.frombuffer(buf, dtype=np.uint8).reshape(self.h, self.w, 3)
            rc = proc.wait()
            reader.join(timeout=5)
            if rc != 0:
                raise DecodeError(rc, "\n".join(list(self.stderr_tail)[-5:]), idx)
        finally:
            _kill(proc)
            reader.join(timeout=2)
            self.proc = None

    def __iter__(self) -> Iterator[Tuple[float, np.ndarray]]:
        next_t = self.start_at
        attempts = [True, False] if self.hwaccel else [False]
        for i, hw in enumerate(attempts):
            produced = 0
            try:
                self.used_hwaccel = hw
                gen = self._run(next_t, hw)
                try:
                    for t, fr in gen:
                        produced += 1
                        next_t = t + 1.0 / config.FRAME_FPS
                        yield t, fr
                finally:
                    gen.close()
                return
            except DecodeError as e:
                if i + 1 < len(attempts):
                    log.warning("decode with hwaccel failed (rc=%s, %d frames); retrying without", e.rc, produced)
                    if produced:
                        self.skip_before = max(self.skip_before, next_t)
                        next_t = max(0.0, next_t - config.RESUME_PREROLL)
                    continue
                if e.frames > 0 or produced > 0:
                    log.warning("decode ended with error after frames (rc=%s): %s", e.rc, e.tail)
                    return
                raise

    def close(self) -> None:
        if self.proc is not None:
            _kill(self.proc)


class DecodeError(RuntimeError):
    def __init__(self, rc: int, tail: str, frames: int) -> None:
        super().__init__("ffmpeg exited with %s: %s" % (rc, tail))
        self.rc, self.tail, self.frames = rc, tail, frames


def _read_exact(f: Any, n: int) -> Optional[bytes]:
    chunks = []
    got = 0
    while got < n:
        b = f.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def _kill(proc: subprocess.Popen) -> None:
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


def decode_all(path: str, width: int, height: int, **kw: Any) -> Tuple[List[float], int]:
    """Convenience for tools/tests: count frames and return cuts."""
    d = Decoder(path, width, height, **kw)
    n = 0
    for _ in d:
        n += 1
    return d.sorted_cuts(), n
