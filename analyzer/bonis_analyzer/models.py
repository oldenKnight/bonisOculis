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


def choose_providers(device: str, warn: Callable[[str], None]) -> Tuple[List[str], str]:
    """Execution providers for --device, falling back to CPU with a warning."""
    import onnxruntime as ort  # noqa: PLC0415

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


def session_factory(threads: int, device: str, warn: Callable[[str], None]) -> Tuple[Callable[[Any], Any], str]:
    """Returns (make_session(path_or_bytes), device actually used)."""
    import onnxruntime as ort  # noqa: PLC0415

    providers, used = choose_providers(device, warn)
    state = {"used": used}

    def options() -> Any:
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, int(threads))
        so.inter_op_num_threads = 1
        so.enable_mem_pattern = False
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
