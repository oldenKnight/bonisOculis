"""Belt and braces against ONNX Runtime telemetry (review A1).

1. requirements.txt pins ONNX Runtime releases without the 1DS uploader.
2. ``bonis_analyzer/__init__.py`` sets ORT_DISABLE_TELEMETRY=1 before
   onnxruntime is imported (the switch read by the 1.29+ native library).
3. ``models.py`` calls ``onnxruntime.disable_telemetry_events()`` (Windows
   ETW provider; a no-op elsewhere).
4. This module: if an ONNX Runtime build ignored all of the above, whatever
   it created during this process (the DeveloperTools cache folder and the
   mat-debug-<pid>.log / .ses files) is deleted when the command ends. Files
   that existed before the run are left alone: they are not ours.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from typing import Dict, List

log = logging.getLogger("bonis.privacy")

TELEMETRY_ENV = "ORT_DISABLE_TELEMETRY"


def _cache_root() -> str:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "Microsoft", "DeveloperTools", ".onnxruntime")


def candidates(pid: int = 0) -> List[str]:
    """Paths the 1DS client is known to create (cache dir, debug log, session file)."""
    tmp = tempfile.gettempdir()
    pid = pid or os.getpid()
    return [_cache_root(), os.path.join(tmp, "mat-debug-%d.log" % pid), os.path.join(tmp, ".ses")]


def snapshot() -> Dict[str, bool]:
    return {p: os.path.exists(p) for p in candidates()}


def sweep(before: Dict[str, bool]) -> List[str]:
    """Remove the candidates that did not exist in ``before``. Returns what was removed."""
    removed = []
    for p in candidates():
        if before.get(p, False) or not os.path.exists(p):
            continue
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            removed.append(p)
        except OSError as e:
            log.warning("could not remove telemetry leftover %s: %s", p, e)
    if removed:
        log.warning("ONNX Runtime telemetry files appeared despite %s=1 and were removed: %s",
                    TELEMETRY_ENV, removed)
    return removed
