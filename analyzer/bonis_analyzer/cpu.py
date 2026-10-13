"""CPU feature detection for the ggml-based stages (llama.cpp dialogue LM,
whisper.cpp speech-to-text).

The llama-cpp-python and pywhispercpp wheels (and whisper-cli builds) are
compiled for AVX2 on x86; on an older x86 CPU (Intel before Haswell, 2013;
AMD before Excavator) they die with an illegal instruction, which no Python
``try`` can catch. The scan therefore asks here first and skips those stages
with a warning. ONNX Runtime picks its kernels at run time and keeps working,
so frames, audio and captions still run.

Detection, best effort and without spawning anything slow:
- Linux: the ``flags`` line of /proc/cpuinfo.
- macOS: arm64 is always supported (ggml uses NEON there); on Intel,
  ``sysctl -n machdep.cpu.leaf7_features`` lists AVX2.
- Windows: ``IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE = 40)``.
- Anything else, or a failed probe: assume supported (the old behaviour);
  ``$BONIS_CPU_AVX2`` = 0/1 overrides (tests, and a user who knows better).
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from typing import Any, Dict, List, Optional

from . import config

PF_AVX2_INSTRUCTIONS_AVAILABLE = 40
_X86 = ("x86_64", "amd64", "i386", "i686", "x86")
# flags worth reporting in `version --cpu-features` (Linux / macOS names)
_REPORTED = ("sse4_2", "avx", "avx2", "fma", "f16c", "avx512f", "neon", "asimd")


def machine() -> str:
    return (platform.machine() or "").lower()


def is_x86(arch: Optional[str] = None) -> bool:
    return (arch if arch is not None else machine()) in _X86


def _linux_flags(path: str = "/proc/cpuinfo") -> Optional[List[str]]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                key, _, val = line.partition(":")
                if key.strip() in ("flags", "Features"):
                    return val.split()
    except OSError:
        return None
    return None


def _sysctl(key: str) -> Optional[str]:
    try:
        r = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _mac_flags() -> Optional[List[str]]:
    """Intel Mac: leaf-7 features (AVX2 lives there) + the basic list. None
    when leaf 7 cannot be read (unknown, not "absent")."""
    leaf7 = _sysctl("machdep.cpu.leaf7_features")
    if leaf7 is None:
        return None
    names = (leaf7 + " " + (_sysctl("machdep.cpu.features") or "")).split()
    out = [x.lower().replace(".", "_") for x in names]
    return [("avx" if x == "avx1_0" else x) for x in out]


def _windows_avx2() -> Optional[bool]:
    try:
        import ctypes  # noqa: PLC0415

        return bool(ctypes.windll.kernel32.IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return None


def features() -> Dict[str, Any]:
    """{"arch", "avx2": True | False | None (unknown), "flags": [...], "source"}."""
    arch = machine()
    info: Dict[str, Any] = {"arch": arch, "avx2": None, "flags": [], "source": "unknown"}
    if sys.platform.startswith("linux"):
        flags = _linux_flags()
        if flags is not None:
            info["flags"] = sorted(f for f in set(flags) if f in _REPORTED)
            info["avx2"] = "avx2" in flags if is_x86(arch) else None
            info["source"] = "/proc/cpuinfo"
    elif sys.platform == "darwin":
        if not is_x86(arch):
            info["avx2"], info["source"], info["flags"] = None, "arm64", ["neon"]
        else:
            flags = _mac_flags()
            if flags is not None:
                info["flags"] = sorted(f for f in set(flags) if f in _REPORTED)
                info["avx2"] = "avx2" in flags
                info["source"] = "sysctl"
    elif os.name == "nt":
        got = _windows_avx2()
        if got is not None:
            info["avx2"], info["source"] = got, "IsProcessorFeaturePresent"
            info["flags"] = ["avx2"] if got else []
    return info


def has_avx2() -> bool:
    """True when AVX2 is present, or the CPU is not x86 (ggml has native
    kernels there), or detection failed (assume the CPU is fine).
    $BONIS_CPU_AVX2 = 0/1 overrides."""
    env = os.environ.get(config.CPU_ENV)
    if env in ("0", "1"):
        return env == "1"
    info = features()
    if not is_x86(info["arch"]) and info["arch"]:
        return True
    return info["avx2"] is not False


def ggml_supported() -> bool:
    """Can the llama.cpp / whisper.cpp stages run on this CPU? (The scan
    calls this through the module so tests can monkeypatch ``has_avx2``.)"""
    return has_avx2()


def report() -> Dict[str, Any]:
    """`version --cpu-features` payload."""
    info = features()
    ok = ggml_supported()
    out = {"arch": info["arch"], "avx2": info["avx2"], "flags": info["flags"], "source": info["source"],
           "ggmlStages": "ok" if ok else "skipped", "skippedStages": [] if ok else list(config.GGML_STAGES)}
    env = os.environ.get(config.CPU_ENV)
    if env in ("0", "1"):
        out["override"] = "%s=%s" % (config.CPU_ENV, env)
    return out
