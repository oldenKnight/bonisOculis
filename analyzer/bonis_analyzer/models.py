"""Model directory resolution and ONNX Runtime session creation."""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Callable, List, Optional, Tuple

log = logging.getLogger("bonis.models")

DEVICE_PROVIDERS = {
    "dml": "DmlExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
    "cuda": "CUDAExecutionProvider",
}


def models_dir(explicit: Optional[str] = None) -> str:
    """--models > $BONIS_MODELS_DIR > bundled models/ > analyzer/models."""
    if explicit:
        return explicit
    env = os.environ.get("BONIS_MODELS_DIR")
    if env:
        return env
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass and os.path.isdir(os.path.join(meipass, "models")):
        return os.path.join(meipass, "models")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")


def _ort() -> Any:
    """onnxruntime, imported with telemetry off (the env switch is set by the
    package __init__; disable_telemetry_events() covers the Windows ETW provider)."""
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    import onnxruntime as ort  # noqa: PLC0415

    try:
        ort.disable_telemetry_events()
    except Exception:  # noqa: BLE001 - absent in some builds
        pass
    return ort


def choose_providers(device: str, warn: Callable[[str], None]) -> Tuple[List[str], str]:
    """Execution providers for --device, falling back to CPU with a warning."""
    ort = _ort()

    avail = ort.get_available_providers()
    device = (device or "auto").lower()
    if device == "cpu":
        return ["CPUExecutionProvider"], "cpu"
    if device == "auto":
        order = ["dml", "coreml"] if os.name == "nt" or sys.platform == "darwin" else []
        for d in order:
            if DEVICE_PROVIDERS[d] in avail:
                return [DEVICE_PROVIDERS[d], "CPUExecutionProvider"], d
        return ["CPUExecutionProvider"], "cpu"
    prov = DEVICE_PROVIDERS.get(device)
    if prov and prov in avail:
        return [prov, "CPUExecutionProvider"], device
    warn("The requested accelerator (%s) is not available; using the processor instead." % device)
    return ["CPUExecutionProvider"], "cpu"


def session_factory(threads: int, device: str, warn: Callable[[str], None],
                    arena: bool = True) -> Tuple[Callable[[Any], Any], str]:
    """Returns (make_session(model path), device actually used). Every ORT
    model (nsfw classifier, CLIP, YAMNet, Florence-2) goes through here; the
    int8 classifier and CLIP use the same provider order, and an accelerator
    that cannot place their quantized ops falls back to the CPU with a warn.
    ``arena=False`` returns activation memory to the OS after every run (the
    Florence-2 vision encoder needs ~0.4 GB of scratch at 768 px; with the arena
    on it stays resident, see analyzer/BENCH.md)."""
    ort = _ort()
    providers, used = choose_providers(device, warn)
    state = {"used": used}

    def options() -> Any:
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, int(threads))
        so.inter_op_num_threads = 1
        so.enable_mem_pattern = False
        so.enable_cpu_mem_arena = bool(arena)
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.log_severity_level = 3
        return so

    def make(src: Any) -> Any:
        try:
            return ort.InferenceSession(src, sess_options=options(), providers=providers)
        except Exception as e:  # noqa: BLE001
            if providers == ["CPUExecutionProvider"]:
                raise
            warn("The accelerator failed to load a model; using the processor instead.")
            log.warning("provider %s failed: %s", providers[0], e)
            state["used"] = "cpu"
            return ort.InferenceSession(src, sess_options=options(), providers=["CPUExecutionProvider"])

    return make, used


# --------------------------------------------------------------------------
# loaded-model registry: "one model set at a time" (docs/PLAN.md section 4)
# --------------------------------------------------------------------------
#
# Every stage registers the model set it loads (``with model_set("audio"):``)
# and releases it before the next stage loads anything. The registry is the
# auditable form of the rule: tests assert ``max_concurrent() == 1`` after a
# full scan. A violation is logged (and recorded), never raised: a scan must
# not die on a bookkeeping error.

import gc as _gc  # noqa: E402
import threading as _threading  # noqa: E402
from contextlib import contextmanager as _contextmanager  # noqa: E402
from typing import Dict as _Dict, Iterator as _Iterator  # noqa: E402

_REG_LOCK = _threading.Lock()
_LOADED: _Dict[str, str] = {}
_HISTORY: List[Tuple[str, str, int]] = []   # (event, set name, sets loaded after the event)
_MAX = {"n": 0}


def register(name: str, detail: str = "") -> None:
    with _REG_LOCK:
        if _LOADED and name not in _LOADED:
            log.error("model set %s loaded while %s is still loaded", name, sorted(_LOADED))
        _LOADED[name] = detail
        _MAX["n"] = max(_MAX["n"], len(_LOADED))
        _HISTORY.append(("load", name, len(_LOADED)))


def trim_heap() -> bool:
    """Hand freed heap pages back to the OS (glibc only; elsewhere a no-op).
    Without it a released model's memory stays resident and the next stage's
    peak stacks on top of it."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        import ctypes  # noqa: PLC0415

        return bool(ctypes.CDLL("libc.so.6").malloc_trim(0))
    except Exception:  # noqa: BLE001
        return False


def release(name: str) -> None:
    with _REG_LOCK:
        _LOADED.pop(name, None)
        _HISTORY.append(("release", name, len(_LOADED)))
    _gc.collect()
    trim_heap()


@_contextmanager
def model_set(name: str, detail: str = "") -> _Iterator[None]:
    """Mark a stage's models as loaded for the duration of the block."""
    register(name, detail)
    try:
        yield
    finally:
        release(name)


def loaded() -> List[str]:
    with _REG_LOCK:
        return sorted(_LOADED)


def max_concurrent() -> int:
    return _MAX["n"]


def history() -> List[Tuple[str, str, int]]:
    with _REG_LOCK:
        return list(_HISTORY)


def reset_registry() -> None:
    """Tests only."""
    with _REG_LOCK:
        _LOADED.clear()
        _HISTORY.clear()
        _MAX["n"] = 0


# --------------------------------------------------------------------------
# releasable model slot (review B6: a paused scan must not keep models in RAM)
# --------------------------------------------------------------------------


class ModelSlot:
    """Wraps a stage's loaded model so the pauser can drop it during a long
    pause and load it again on resume. Attribute access is forwarded to the
    model (stage code keeps calling ``slot.score(...)``); a released slot
    reloads itself on first use if nobody reloaded it."""

    def __init__(self, name: str, obj: Any, factory: Callable[[], Any], detail: str = "") -> None:
        self.__dict__.update(_name=name, _obj=obj, _factory=factory, _detail=detail or type(obj).__name__,
                             releases=0, reloads=0)

    @property
    def loaded(self) -> bool:
        return self._obj is not None

    def release(self) -> None:
        """close + drop the model, release its registry entry, gc, trim the heap."""
        obj = self._obj
        if obj is None:
            return
        self.__dict__["_obj"] = None
        try:
            obj.close()
        except Exception as e:  # noqa: BLE001 - releasing must not fail a paused scan
            log.warning("closing %s on pause failed: %s", self._name, e)
        del obj
        self.__dict__["releases"] += 1
        release(self._name)
        log.info("pause: released model set %s", self._name)

    def reload(self) -> None:
        if self._obj is not None:
            return
        obj = self._factory()
        if obj is None:
            from .protocol import ModelMissing  # noqa: PLC0415

            raise ModelMissing("the %s model could not be loaded again after the pause" % self._name)
        self.__dict__["_obj"] = obj
        self.__dict__["reloads"] += 1
        register(self._name, self._detail)
        log.info("resume: reloaded model set %s", self._name)

    def close(self) -> None:
        obj = self._obj
        self.__dict__["_obj"] = None
        if obj is not None:
            obj.close()

    def __getattr__(self, attr: str) -> Any:
        if self.__dict__.get("_obj") is None:
            self.reload()
        return getattr(self.__dict__["_obj"], attr)

    def __setattr__(self, attr: str, value: Any) -> None:
        if self._obj is None:
            self.reload()
        setattr(self._obj, attr, value)
