"""Fusion: per-second signal scores -> skip ranges.

score[c][t] = 1 - prod_s (1 - w[s][c] * signal[s][c][t])     (noisy-OR)
Seconds at or above the level threshold form runs; runs closer than
MERGE_GAP merge; each run snaps outward to the enclosing shot (nearest scene
cut at/before the start and at/after the end, at most MAX_SNAP away); then
lead-in / tail padding, minimum duration, confidence = max score, intensity
from score bands plus signal agreement, default action from the level, and a
template note. Deterministic: same inputs -> same ranges and ids.
"""

from __future__ import annotations

import bisect
import hashlib
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import config, notes

Signals = Dict[str, Dict[str, Any]]


def seconds_count(duration: float, signals: Optional[Signals] = None) -> int:
    n = int(math.ceil(max(0.0, duration) - 1e-9)) if duration and duration > 0 else 0
    if n == 0 and signals:
        for per_cat in signals.values():
            for a in per_cat.values():
                n = max(n, len(a))
    return max(1, n)


def fit(a: Any, n: int) -> np.ndarray:
    v = np.zeros(n, dtype=np.float64)
    if a is None:
        return v
    arr = np.nan_to_num(np.asarray(a, dtype=np.float64).ravel(), nan=0.0, posinf=1.0, neginf=0.0)
    m = min(n, len(arr))
    v[:m] = np.clip(arr[:m], 0.0, 1.0)
    return v


def combine(signals: Signals, category: str, n: int) -> np.ndarray:
    keep = np.ones(n, dtype=np.float64)
    for s in config.SIGNALS:
        per_cat = signals.get(s) or {}
        if category not in per_cat:
            continue
        w = config.SIGNAL_WEIGHTS.get(s, {}).get(category, 0.0)
        if w <= 0:
            continue
        keep *= 1.0 - w * fit(per_cat[category], n)
    return 1.0 - keep


def runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """[start, end) second index runs where mask is True."""
    out: List[Tuple[int, int]] = []
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return out
    start = prev = int(idx[0])
    for j in idx[1:]:
        j = int(j)
        if j != prev + 1:
            out.append((start, prev + 1))
            start = j
        prev = j
    out.append((start, prev + 1))
    return out


def _timing(category: str) -> Dict[str, Any]:
    t = {"snap": True, "lead_in": config.LEAD_IN, "tail": config.TAIL, "merge_gap": config.MERGE_GAP}
    t.update(config.CATEGORY_TIMING.get(category, {}))
    return t


def _snap_start(cuts: Sequence[float], t: float) -> Optional[float]:
    i = bisect.bisect_right(cuts, t + 1e-6) - 1
    if i >= 0 and t - cuts[i] <= config.MAX_SNAP:
        return float(cuts[i])
    return None


def _snap_end(cuts: Sequence[float], t: float) -> Optional[float]:
    i = bisect.bisect_left(cuts, t - 1e-6)
    if i < len(cuts) and cuts[i] - t <= config.MAX_SNAP:
        return float(cuts[i])
    return None


def _r3(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000


def _intensity(conf: float, agreeing: int) -> int:
    base = 1
    for lo, v in config.INTENSITY_BANDS:
        if conf >= lo:
            base = v
            break
    if agreeing >= 2:
        base += 1
    return int(min(3, max(1, base)))


def range_id(category: str, start: float, end: float) -> str:
    h = hashlib.sha1(("%s|%.3f|%.3f" % (category, start, end)).encode("ascii")).hexdigest()
    return "r" + h[:10]


def fuse(signals: Signals, cuts: Sequence[float], duration: float, levels: Dict[str, str],
         lang: str = "en-US") -> List[Dict[str, Any]]:
    """Fuse per-second signal arrays into skip ranges (sorted by start, category)."""
    n = seconds_count(duration, signals)
    dur = float(duration) if duration and duration > 0 else float(n)
    cuts = sorted(float(c) for c in (cuts or []) if 0 < float(c) < dur)
    out: List[Dict[str, Any]] = []
    for cat in config.CATEGORIES:
        level = levels.get(cat, config.DEFAULT_LEVELS.get(cat, "off"))
        thr = config.threshold(level)
        if thr is None:
            continue
        score = combine(signals, cat, n)
        mask = score >= thr - 1e-9
        rs = runs(mask)
        if not rs:
            continue
        tm = _timing(cat)
        # 1. merge close runs
        merged: List[List[Any]] = []
        for a, b in rs:
            if merged and a - merged[-1][1] < tm["merge_gap"]:
                merged[-1][1] = b
                merged[-1][2].append((a, b))
            else:
                merged.append([a, b, [(a, b)]])
        # 2. snap to the enclosing shot
        items = []
        for a, b, core in merged:
            start, end = float(a), float(b)
            cs = ce = None
            if tm["snap"] and cuts:
                cs = _snap_start(cuts, start)
                ce = _snap_end(cuts, end)
                if cs is not None:
                    start = cs
                if ce is not None:
                    end = ce
            items.append({"start": start, "end": end, "cutStart": cs, "cutEnd": ce, "core": list(core)})
        # 3. merge again (snapping can close gaps), 4. pad, 5. min duration, 6. merge overlaps
        items = _merge_items(items, tm["merge_gap"])
        for it in items:
            it["start"] = max(0.0, it["start"] - tm["lead_in"])
            it["end"] = min(dur, it["end"] + tm["tail"])
            if it["end"] - it["start"] < config.MIN_DURATION:
                it["end"] = min(dur, it["start"] + config.MIN_DURATION)
                if it["end"] - it["start"] < config.MIN_DURATION:
                    it["start"] = max(0.0, it["end"] - config.MIN_DURATION)
        items = _merge_items(items, 0.0)
        for it in items:
            out.append(_finish(it, cat, level, score, signals, n, lang))
    out.sort(key=lambda r: (r["start"], r["end"], config.CATEGORIES.index(r["category"])))
    return out


def _merge_items(items: List[Dict[str, Any]], gap: float) -> List[Dict[str, Any]]:
    items = sorted(items, key=lambda x: (x["start"], x["end"]))
    out: List[Dict[str, Any]] = []
    for it in items:
        if out and (it["start"] <= out[-1]["end"] + 1e-9 or it["start"] - out[-1]["end"] < gap):
            last = out[-1]
            if it["end"] > last["end"]:
                last["end"] = it["end"]
                last["cutEnd"] = it["cutEnd"]
            last["core"].extend(it["core"])
        else:
            out.append(dict(it, core=list(it["core"])))
    return out


def _finish(it: Dict[str, Any], cat: str, level: str, score: np.ndarray, signals: Signals, n: int,
            lang: str) -> Dict[str, Any]:
    start, end = _r3(it["start"]), _r3(it["end"])
    conf = 0.0
    for a, b in it["core"]:
        conf = max(conf, float(score[a:b].max()))
    lo, hi = max(0, int(math.floor(start))), min(n, max(int(math.ceil(end)), int(math.floor(start)) + 1))
    peaks: Dict[str, float] = {}
    for s in config.SIGNALS:
        per_cat = signals.get(s) or {}
        if cat in per_cat and config.SIGNAL_WEIGHTS.get(s, {}).get(cat, 0) > 0:
            v = fit(per_cat[cat], n)[lo:hi]
            peaks[s] = _r3(float(v.max()) if v.size else 0.0)
    present = [s for s in config.SIGNALS if peaks.get(s, 0.0) >= config.SIGNAL_PRESENT]
    r: Dict[str, Any] = {
        "id": range_id(cat, start, end),
        "start": start,
        "end": end,
        "category": cat,
        "confidence": _r3(min(1.0, conf)),
        "intensity": _intensity(conf, len(present)),
        "action": config.default_action(cat, level),
        "source": "auto",
        "review": "pending",
        "signals": {k: v for k, v in peaks.items() if v > 0},
        "note": notes.note(cat, present, lang),
    }
    if it.get("cutStart") is not None:
        r["cutStart"] = _r3(it["cutStart"])
    if it.get("cutEnd") is not None:
        r["cutEnd"] = _r3(it["cutEnd"])
    return r
