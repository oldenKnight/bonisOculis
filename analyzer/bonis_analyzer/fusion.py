"""Fusion: per-second signal scores -> skip ranges.

score[c][t] = 1 - prod_s (1 - w[s][c] * signal[s][c][t])     (noisy-OR)
then, where >= AGREE_MIN_SIGNALS signals from different groups (picture,
description, dialogue, sound) each reach AGREE_MIN:
score[c][t] = 1 - (1 - score[c][t]) * (1 - AGREE_BONUS)       (agreement)
Seconds at or above the level threshold form runs; runs closer than
MERGE_GAP merge; each run snaps outward to the enclosing shot (nearest scene
cut at/before the start and at/after the end, at most MAX_SNAP away); then
lead-in / tail padding, a per-category minimum duration, confidence = max
score, intensity from score bands plus signal agreement, default action from
the level, and a template note. Deterministic: same inputs -> same ranges and
ids. Every constant is in config.py and explained in analyzer/TUNING.md.
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


Weights = Dict[str, Dict[str, float]]


def _weight(weights: Optional[Weights], s: str, category: str) -> float:
    return float((weights if weights is not None else config.SIGNAL_WEIGHTS).get(s, {}).get(category, 0.0))


def combine(signals: Signals, category: str, n: int, weights: Optional[Weights] = None) -> np.ndarray:
    """Weighted noisy-OR of the signals (no agreement bonus)."""
    keep = np.ones(n, dtype=np.float64)
    for s in config.SIGNALS:
        per_cat = signals.get(s) or {}
        if category not in per_cat:
            continue
        w = _weight(weights, s, category)
        if w <= 0:
            continue
        keep *= 1.0 - w * fit(per_cat[category], n)
    return 1.0 - keep


def agreement(signals: Signals, category: str, n: int, weights: Optional[Weights] = None,
              agree_min: Optional[float] = None) -> np.ndarray:
    """Per second: number of distinct signal GROUPS whose raw score reaches
    AGREE_MIN (only signals that count for the category, weight > 0)."""
    thr = config.AGREE_MIN if agree_min is None else agree_min
    groups: Dict[str, np.ndarray] = {}
    for s in config.SIGNALS:
        per_cat = signals.get(s) or {}
        if category not in per_cat or _weight(weights, s, category) <= 0:
            continue
        g = config.SIGNAL_GROUPS.get(s, s)
        hit = fit(per_cat[category], n) >= thr - 1e-9
        groups[g] = groups[g] | hit if g in groups else hit
    out = np.zeros(n, dtype=np.int64)
    for hit in groups.values():
        out += hit
    return out


def fused_score(signals: Signals, category: str, n: int, weights: Optional[Weights] = None,
                bonus: Optional[float] = None) -> np.ndarray:
    """Noisy-OR plus the agreement bonus: the per-second score fusion thresholds."""
    p = combine(signals, category, n, weights)
    b = config.AGREE_BONUS if bonus is None else bonus
    if b > 0 and category in config.AGREE_CATEGORIES:
        agree = agreement(signals, category, n, weights) >= config.AGREE_MIN_SIGNALS
        if agree.any():
            p = np.where(agree, 1.0 - (1.0 - p) * (1.0 - b), p)
    return np.clip(p, 0.0, 1.0)


def assemble_signals(stage_arrays: Dict[str, Optional[Dict[str, Any]]], n: int) -> Tuple[Signals, List[float]]:
    """Stage results (the <work>/*.npz contents) -> fusion signals + cuts.
    The ONE place that decides how stages become signals; the scan and
    tools/tune.py both use it, so tuning sees exactly what a scan fuses.

    frames.npz -> "frames" (+ "cuts"); subtitles.npz (keywords) and
    speech.npz (keywords over the transcript) -> "subtitles" / "speech", each
    max()ed with LM_WEIGHT * lm.npz when lm.npz["source"] names it;
    audio.npz -> "audio"; captions.npz -> "captions" (already lexicon+LM)."""
    signals: Signals = {}
    cuts: List[float] = []
    fr = stage_arrays.get("frames")
    if fr:
        signals["frames"] = {c: fr[c] for c in config.VISUAL_CATEGORIES if c in fr}
        cuts = [float(c) for c in np.asarray(fr.get("cuts", []), dtype=np.float64).ravel()]
    lm = stage_arrays.get("lm")
    lm_source = None
    if lm:
        src = lm.get("source")
        lm_source = str(np.asarray(src).item()) if src is not None else "subtitles"
    for name in ("subtitles", "speech"):
        kw = stage_arrays.get(name)
        if not kw:
            continue
        sig = {c: np.asarray(kw[c], dtype=np.float32) for c in config.CATEGORIES if c in kw}
        if lm and lm_source == name:
            for c in config.LM_CATEGORIES:
                if c in lm:
                    base = sig.get(c, np.zeros(n, np.float32))
                    sig[c] = np.maximum(fit(base, n), config.LM_WEIGHT * fit(lm[c], n)).astype(np.float32)
        signals[name] = sig
    au = stage_arrays.get("audio")
    if au:
        signals["audio"] = {c: au[c] for c in config.CATEGORIES if c in au}
    cap = stage_arrays.get("captions")
    if cap:
        signals["captions"] = {c: cap[c] for c in config.VISUAL_CATEGORIES if c in cap}
    return signals, cuts


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


def min_duration(category: str) -> float:
    return float(config.CATEGORY_MIN_DURATION.get(category, config.MIN_DURATION))


def fuse(signals: Signals, cuts: Sequence[float], duration: float, levels: Dict[str, str],
         lang: str = "en-US", weights: Optional[Weights] = None,
         thresholds: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    """Fuse per-second signal arrays into skip ranges (sorted by start, category).
    ``weights`` / ``thresholds`` override config (tools/tune.py)."""
    n = seconds_count(duration, signals)
    dur = float(duration) if duration and duration > 0 else float(n)
    cuts = sorted(float(c) for c in (cuts or []) if 0 < float(c) < dur)
    out: List[Dict[str, Any]] = []
    for cat in config.CATEGORIES:
        level = levels.get(cat, config.DEFAULT_LEVELS.get(cat, "off"))
        thr = config.threshold(level)
        if thr is None:
            continue
        if thresholds and cat in thresholds:
            thr = float(thresholds[cat])
        score = fused_score(signals, cat, n, weights)
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
        mind = min_duration(cat)
        for it in items:
            it["start"] = max(0.0, it["start"] - tm["lead_in"])
            it["end"] = min(dur, it["end"] + tm["tail"])
            if it["end"] - it["start"] < mind:
                it["end"] = min(dur, it["start"] + mind)
                if it["end"] - it["start"] < mind:
                    it["start"] = max(0.0, it["end"] - mind)
        items = _merge_items(items, 0.0)
        for it in items:
            out.append(_finish(it, cat, level, score, signals, n, lang, weights))
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
            lang: str, weights: Optional[Weights] = None) -> Dict[str, Any]:
    start, end = _r3(it["start"]), _r3(it["end"])
    conf = 0.0
    for a, b in it["core"]:
        conf = max(conf, float(score[a:b].max()))
    lo, hi = max(0, int(math.floor(start))), min(n, max(int(math.ceil(end)), int(math.floor(start)) + 1))
    peaks: Dict[str, float] = {}
    for s in config.SIGNALS:
        per_cat = signals.get(s) or {}
        if cat in per_cat and _weight(weights, s, cat) > 0:
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
