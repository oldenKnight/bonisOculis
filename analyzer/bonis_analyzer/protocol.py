"""stdout JSON-lines protocol between the analyzer and Electron main
(docs/PLAN.md section 2.4).

    {"t":"progress","stage":"frames","p":0.42,"eta":610}
    {"t":"stage","stage":"frames","status":"done"}
    {"t":"warn","msg":"..."}
    {"t":"paused"} / {"t":"resumed"}
    {"t":"done","out":"/path/movie.bonis.json"}
    {"t":"error","code":3,"msg":"..."}
    {"t":"profile","stages":{...},"peakRssMB":...}   (scan --profile only, after "done")

stdout carries ONLY these lines (one JSON object per line, flushed). Logs go
to stderr. Exit codes below.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, IO, Optional

EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_MODEL_MISSING = 3
EXIT_INTERRUPTED = 4
EXIT_INTERNAL = 5


class AnalyzerError(Exception):
    code = EXIT_INTERNAL


class BadInput(AnalyzerError):
    code = EXIT_BAD_INPUT


class ModelMissing(AnalyzerError):
    code = EXIT_MODEL_MISSING


class Interrupted(AnalyzerError):
    code = EXIT_INTERRUPTED


class Protocol:
    """Thread-safe writer of protocol lines. Progress lines are throttled."""

    def __init__(self, stream: Optional[IO[str]] = None, min_interval: float = 0.5) -> None:
        self.stream = stream if stream is not None else sys.stdout
        self.lock = threading.Lock()
        self.min_interval = min_interval
        self._last: dict = {}
        self.warnings: list = []

    def isolate_stdout(self) -> bool:
        """Move the protocol onto a private duplicate of fd 1 and point fd 1 at
        stderr, so a native library printing to stdout can only reach the log.
        Only when writing to the real stdout; best effort."""
        if self.stream is not sys.stdout:
            return False
        try:
            self.stream.flush()
            fd = os.dup(1)
            os.dup2(2, 1)
            self.stream = os.fdopen(fd, "w", encoding="utf-8", errors="replace", buffering=1)
            return True
        except (OSError, ValueError, AttributeError):
            return False

    def emit(self, obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self.lock:
            try:
                self.stream.write(line + "\n")
                self.stream.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass  # the supervisor went away; keep working, the checkpoint is what matters

    def progress(self, stage: str, p: float, eta: Optional[float] = None, force: bool = False) -> None:
        p = max(0.0, min(1.0, float(p)))
        now = time.monotonic()
        last = self._last.get(stage)
        if not force and last is not None:
            lt, lp = last
            if now - lt < self.min_interval and p < 1.0 and abs(p - lp) < 0.05:
                return
        self._last[stage] = (now, p)
        obj: dict[str, Any] = {"t": "progress", "stage": stage, "p": round(p, 4)}
        if eta is not None:
            obj["eta"] = int(max(0, round(eta)))
        self.emit(obj)

    def stage(self, stage: str, status: str, **extra: Any) -> None:
        obj: dict[str, Any] = {"t": "stage", "stage": stage, "status": status}
        obj.update(extra)
        self.emit(obj)

    def warn(self, msg: str) -> None:
        msg = str(msg)[:500]
        if msg not in self.warnings:
            self.warnings.append(msg)
        self.emit({"t": "warn", "msg": msg})

    def paused(self) -> None:
        self.emit({"t": "paused"})

    def resumed(self) -> None:
        self.emit({"t": "resumed"})

    def done(self, out: str) -> None:
        self.emit({"t": "done", "out": out})

    def error(self, code: int, msg: str) -> None:
        self.emit({"t": "error", "code": int(code), "msg": str(msg)[:1000]})


class Eta:
    """Remaining-time estimate from progress made since this run started."""

    def __init__(self, p0: float = 0.0) -> None:
        self.t0 = time.monotonic()
        self.p0 = p0

    def __call__(self, p: float) -> Optional[float]:
        done = p - self.p0
        if done <= 1e-6:
            return None
        return (time.monotonic() - self.t0) * (1.0 - p) / done


def parse_line(line: str) -> dict:
    """Parse and check one protocol line (used by tests and tools)."""
    obj = json.loads(line)
    if not isinstance(obj, dict) or not isinstance(obj.get("t"), str):
        raise ValueError("not a protocol object")
    t = obj["t"]
    if t == "progress":
        assert isinstance(obj.get("stage"), str) and 0 <= obj.get("p") <= 1
    elif t == "stage":
        assert isinstance(obj.get("stage"), str) and obj.get("status") in (
            "pending", "running", "done", "skipped", "failed")
    elif t == "warn":
        assert isinstance(obj.get("msg"), str)
    elif t == "done":
        assert isinstance(obj.get("out"), str)
    elif t == "error":
        assert isinstance(obj.get("code"), int) and isinstance(obj.get("msg"), str)
    elif t == "profile":
        assert isinstance(obj.get("stages"), dict)
    elif t not in ("paused", "resumed"):
        raise ValueError("unknown line type %r" % t)
    return obj
