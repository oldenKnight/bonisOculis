"""`scan --profile`: per-stage wall time and peak resident memory, without
psutil. Linux: the kernel's peak-RSS counter (VmHWM) is reset at each stage
start (/proc/self/clear_refs = 5) and read at its end, plus a 50 ms sampler
as a fallback; Windows: GetProcessMemoryInfo; macOS: getrusage (lifetime peak
only, so per-stage peaks are the running maximum there). Children (ffmpeg,
whisper-cli) are not included: on Linux a child's maxrss counts the parent's
pages it shared before exec, which makes that number meaningless.

The final protocol line:
    {"t":"profile","stages":{"frames":{"wall":12.3,"peakRssMB":238.1},...},
     "peakRssMB":930.2,"framesProcessed":60,
     "shotsCaptioned":3,"windowsScored":{"lm":1,"speech":3,"audioChunks":6}}
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Any, Dict, Optional

_PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def _proc_status(key: str) -> Optional[int]:
    try:
        with open("/proc/self/status", encoding="ascii", errors="replace") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _win_mem() -> Optional[Any]:
    if os.name != "nt":
        return None
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
        if psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return pmc
    except Exception:  # noqa: BLE001
        return None
    return None


def rss_bytes() -> Optional[int]:
    """Current resident set size of this process."""
    try:
        with open("/proc/self/statm", encoding="ascii") as f:
            return int(f.read().split()[1]) * _PAGE
    except (OSError, ValueError, IndexError):
        pass
    pmc = _win_mem()
    if pmc is not None:
        return int(pmc.WorkingSetSize)
    return None


def peak_rss_bytes() -> Optional[int]:
    """Lifetime (or since the last reset, Linux) peak RSS of this process."""
    v = _proc_status("VmHWM")
    if v is not None:
        return v
    pmc = _win_mem()
    if pmc is not None:
        return int(pmc.PeakWorkingSetSize)
    try:
        import resource  # noqa: PLC0415

        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(r if sys.platform == "darwin" else r * 1024)
    except Exception:  # noqa: BLE001
        return None


def reset_peak() -> bool:
    """Reset the kernel peak-RSS counter (Linux >= 4.0). Best effort."""
    try:
        with open("/proc/self/clear_refs", "w", encoding="ascii") as f:
            f.write("5")
        return True
    except OSError:
        return False


def _mb(b: Optional[int]) -> Optional[float]:
    return None if b is None else round(b / (1024.0 * 1024.0), 1)


class Profiler:
    """Per-stage wall time and peak RSS. Disabled -> every call is a no-op
    except the counters (cheap), so the scan code needs no branches."""

    def __init__(self, enabled: bool = False, interval: float = 0.05) -> None:
        self.enabled = enabled
        self.interval = interval
        self.stages: Dict[str, Dict[str, float]] = {}
        self.counters: Dict[str, Any] = {"framesProcessed": 0, "shotsCaptioned": 0,
                                         "windowsScored": {"lm": 0, "speech": 0, "audioChunks": 0, "captionLm": 0}}
        self._cur: Optional[str] = None
        self._t0 = 0.0
        self._peak = 0
        self._overall = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._can_reset = False
        if enabled:
            self._thread = threading.Thread(target=self._sample, name="bonis-profiler", daemon=True)
            self._thread.start()

    def _sample(self) -> None:
        while not self._stop.wait(self.interval):
            r = rss_bytes()
            if r is None:
                continue
            with self._lock:
                self._peak = max(self._peak, r)
                self._overall = max(self._overall, r)

    def begin(self, name: str) -> None:
        if not self.enabled:
            return
        if self._cur is not None:
            self.end(self._cur)
        self._can_reset = reset_peak()
        with self._lock:
            self._cur = name
            self._t0 = time.monotonic()
            self._peak = rss_bytes() or 0

    def end(self, name: str) -> None:
        if not self.enabled or self._cur != name:
            return
        wall = time.monotonic() - self._t0
        hw = peak_rss_bytes() if self._can_reset else None
        with self._lock:
            peak = max(self._peak, hw or 0, rss_bytes() or 0)
            self._overall = max(self._overall, peak)
            st = self.stages.setdefault(name, {"wall": 0.0, "peakRssMB": 0.0})
            st["wall"] = round(st["wall"] + wall, 3)
            st["peakRssMB"] = max(st["peakRssMB"], _mb(peak) or 0.0)
            self._cur = None

    def count(self, key: str, n: int = 1) -> None:
        if key in self.counters["windowsScored"]:
            self.counters["windowsScored"][key] += n
        else:
            self.counters[key] = self.counters.get(key, 0) + n

    def report(self) -> Dict[str, Any]:
        if self._cur is not None:
            self.end(self._cur)
        self._stop.set()
        overall = max(self._overall, 0)
        if not self._can_reset:
            overall = max(overall, peak_rss_bytes() or 0)
        out: Dict[str, Any] = {"t": "profile", "stages": self.stages, "peakRssMB": _mb(overall)}
        out.update(self.counters)
        return out
