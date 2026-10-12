"""External tool resolution (ffmpeg/ffprobe), subprocess flags, process priority."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from typing import Any, Dict

from ..protocol import BadInput


def _bundled(name: str) -> str:
    exe = name + (".exe" if os.name == "nt" else "")
    roots = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots += [os.path.join(meipass, "bin"), meipass]
    roots.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "bin"))
    for r in roots:
        p = os.path.join(r, exe)
        if os.path.isfile(p):
            return p
    return ""


def tool(name: str) -> str:
    """Path of ffmpeg / ffprobe: $BONIS_FFMPEG / $BONIS_FFPROBE, bundled bin/, then PATH."""
    env = os.environ.get("BONIS_" + name.upper())
    if env and os.path.isfile(env):
        return env
    p = _bundled(name) or shutil.which(name) or ""
    if not p:
        raise BadInput("%s not found; reinstall bonis oculis" % name)
    return p


def popen_kwargs() -> Dict[str, Any]:
    """No console window on Windows; children inherit our (low) priority."""
    kw: Dict[str, Any] = {}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kw


def lower_priority() -> bool:
    """Below-normal priority for this process; ffmpeg children inherit it."""
    try:
        if os.name == "nt":
            import ctypes  # noqa: PLC0415

            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            return bool(k32.SetPriorityClass(k32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS))
        os.nice(10)
        return True
    except Exception:  # noqa: BLE001 - priority is best effort
        return False
