"""<work>/state.json + per-stage .npz results; resume logic.

state.json = {"version": 1, "inputFingerprint": {...},
              "stages": {name: {"status", "progress", "resumeAt", ...}}}

Every write is atomic (tmp + os.replace). Stage arrays are per-second
float32 .npz files. A scan whose inputFingerprint (file hash + options that
change stage results) differs from the stored one starts over.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from typing import Any, Dict, Iterable, Optional

import numpy as np

from .. import config
from ..protocol import BadInput

STATE = "state.json"
THUMBS = "thumbs"
PAUSE = "PAUSE"
_OWNED_EXT = (".npz", ".json", ".tmp", ".log", ".jpg", ".wav")  # .wav: whisper-cli temp (deleted in finally)


def atomic_write_bytes(path: str, data: bytes) -> None:
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def atomic_write_json(path: str, obj: Any) -> None:
    atomic_write_bytes(path, (json.dumps(obj, indent=1, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))


def _owned(name: str) -> bool:
    return name in (STATE, THUMBS, PAUSE) or name.endswith(_OWNED_EXT)


class Checkpoint:
    def __init__(self, work: str) -> None:
        self.work = os.path.abspath(work)
        self.state: Dict[str, Any] = {"version": 1, "inputFingerprint": None, "stages": {}}
        self.resumed = False

    # lifecycle ---------------------------------------------------------------
    def open(self, fingerprint: Dict[str, Any], restart: bool = False) -> bool:
        """Create/validate the work dir. Returns True when previous progress is reused."""
        if os.path.exists(self.work) and not os.path.isdir(self.work):
            raise BadInput("work path is not a directory")
        os.makedirs(self.work, exist_ok=True)
        names = os.listdir(self.work)
        if STATE not in names and any(not _owned(n) for n in names):
            raise BadInput("work directory is not empty and was not created by bonis oculis")
        old = self._read_state()
        if restart or old is None or old.get("inputFingerprint") != fingerprint:
            self.wipe()
            self.state = {"version": 1, "inputFingerprint": fingerprint, "stages": {}}
            self.save()
            self.resumed = False
        else:
            self.state = old
            self.state.setdefault("stages", {})
            self.resumed = True
        return self.resumed

    def _read_state(self) -> Optional[Dict[str, Any]]:
        p = os.path.join(self.work, STATE)
        try:
            with open(p, encoding="utf-8") as f:
                s = json.load(f)
            return s if isinstance(s, dict) and isinstance(s.get("stages"), dict) else None
        except (OSError, ValueError):
            return None

    def save(self) -> None:
        atomic_write_json(os.path.join(self.work, STATE), self.state)

    def wipe(self) -> None:
        """Remove everything this analyzer owns in <work> (never PAUSE)."""
        if not os.path.isdir(self.work):
            return
        for n in os.listdir(self.work):
            p = os.path.join(self.work, n)
            if n == PAUSE or not _owned(n):
                continue
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def cleanup_after_done(self, keep_stage_files: Iterable[str]) -> None:
        """Delete everything except state.json, the stage .npz files and thumbs/."""
        keep = {STATE, THUMBS, PAUSE} | {n + ".npz" for n in keep_stage_files}
        for n in os.listdir(self.work):
            if n in keep:
                continue
            p = os.path.join(self.work, n)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.remove(p)
                except OSError:
                    pass

    # stages -----------------------------------------------------------------
    def stage(self, name: str) -> Dict[str, Any]:
        return self.state["stages"].setdefault(name, {"status": "pending", "progress": 0.0})

    def is_done(self, name: str) -> bool:
        st = self.state["stages"].get(name) or {}
        return st.get("status") in ("done", "skipped") and (
            st.get("status") == "skipped" or self.has_arrays(name) or st.get("noArrays") is True)

    def set_stage(self, name: str, status: Optional[str] = None, save: bool = True, **fields: Any) -> None:
        st = self.stage(name)
        if status is not None:
            st["status"] = status
            if status == "running" and "startedAt" not in st:
                st["startedAt"] = time.time()
        for k, v in fields.items():
            if v is None:
                st.pop(k, None)
            else:
                st[k] = v
        if save:
            self.save()

    def reset_stage(self, name: str) -> None:
        self.state["stages"].pop(name, None)
        p = self._npz(name)
        if os.path.exists(p):
            os.remove(p)
        self.save()

    # arrays -----------------------------------------------------------------
    def _npz(self, name: str) -> str:
        return os.path.join(self.work, name + ".npz")

    def has_arrays(self, name: str) -> bool:
        return os.path.isfile(self._npz(name))

    def save_arrays(self, name: str, arrays: Dict[str, Any]) -> None:
        p = self._npz(name)
        tmp = p + ".tmp"
        clean = {}
        for k, v in arrays.items():
            a = np.asarray(v)
            clean[k] = a.astype(np.float32) if a.dtype.kind == "f" and k != "cuts" else a
        with open(tmp, "wb") as f:
            np.savez(f, **clean)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, p)

    def load_arrays(self, name: str) -> Optional[Dict[str, np.ndarray]]:
        p = self._npz(name)
        if not os.path.isfile(p):
            return None
        try:
            with np.load(p, allow_pickle=False) as z:
                return {k: np.array(z[k]) for k in z.files}
        except (OSError, ValueError, EOFError):
            return None

    # small json side files (deleted after done) -------------------------------
    def write_json(self, name: str, obj: Any) -> None:
        atomic_write_json(os.path.join(self.work, name), obj)

    def read_json(self, name: str) -> Any:
        try:
            with open(os.path.join(self.work, name), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    # pause ------------------------------------------------------------------
    def pause_requested(self) -> bool:
        return os.path.exists(os.path.join(self.work, PAUSE))


class Pauser:
    """Polls <work>/PAUSE at most once per second; blocks while it exists.
    While blocked nothing reads the decode pipe, so ffmpeg stalls on it.

    ``slot`` (models.ModelSlot, set by the running stage): after
    ``release_after`` seconds of pause the stage's model set is released
    (close, gc, heap trim) so a paused scan does not hold ~1 GB while the
    player runs (review B6); it is loaded again when the pause ends."""

    def __init__(self, ckpt: Checkpoint, protocol: Any = None, interval: float = 1.0,
                 sleep: Any = time.sleep, on_pause: Any = None, release_after: Optional[float] = None) -> None:
        self.ckpt = ckpt
        self.protocol = protocol
        self.interval = interval
        self.sleep = sleep
        self.on_pause = on_pause
        self.release_after = config.PAUSE_RELEASE_AFTER if release_after is None else release_after
        self.slot: Any = None
        self._last = 0.0
        self.pauses = 0

    def check(self) -> None:
        now = time.monotonic()
        if now - self._last < self.interval:
            return
        self._last = now
        if not self.ckpt.pause_requested():
            return
        self.pauses += 1
        if self.on_pause:
            self.on_pause()
        if self.protocol:
            self.protocol.paused()
        started = time.monotonic()
        released = False
        while self.ckpt.pause_requested():
            if (not released and self.slot is not None and self.slot.loaded
                    and time.monotonic() - started >= self.release_after):
                self.slot.release()
                released = True
            self.sleep(self.interval)
        if released and self.slot is not None:
            self.slot.reload()
        self._last = time.monotonic()
        if self.protocol:
            self.protocol.resumed()
