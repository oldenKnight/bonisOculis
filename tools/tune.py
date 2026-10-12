#!/usr/bin/env python3
"""Grid-search fusion weights and thresholds against hand-marked films.

    python3 tools/tune.py CASES [--categories sex,gore] [--weights 0,0.35,0.6,0.85,1]
                               [--thresholds 0.3,0.4,0.5,0.6,0.7,0.8] [--beta 2] [--top 5] [--json out.json]

CASES is a folder of case folders, each holding
    truth.bonis.json   the parent's hand-marked skip file (only enforced ranges count)
    work/              the scan's work dir (stage .npz files: frames, subtitles, speech,
                       lm, audio, captions; kept after every scan)
Signals are rebuilt with bonis_analyzer.fusion.assemble_signals and ranges with
bonis_analyzer.fusion.fuse, so a row here is exactly what a scan with those
weights and that threshold would write. Seconds are scored like the
`evaluate` command (a second counts when its midpoint is inside a range).

For each category the grid is every combination of the weight values for the
signals that carry that category in at least one case, times every threshold.
Rows are ranked by F-beta (beta 2 by default: recall counts four times as much
as precision, the brief's "catch too much"); the first table row is the
current config.py setting. Nothing is written unless --json is given; to adopt
a row, copy its weights into SIGNAL_WEIGHTS and its threshold into the level
table (see analyzer/TUNING.md).
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "analyzer"))

import numpy as np  # noqa: E402

from bonis_analyzer import config, fusion  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402
from bonis_analyzer.evaluate import _seconds  # noqa: E402

STAGES = ("frames", "subtitles", "speech", "lm", "audio", "captions")


def load_case(path: str) -> Dict[str, Any]:
    with open(os.path.join(path, "truth.bonis.json"), "rb") as f:
        res = sf.from_json(f.read())
    if not res["ok"]:
        raise SystemExit("%s: truth.bonis.json is not a valid skip file: %s" % (path, res["errors"][:3]))
    truth = res["doc"]
    work = os.path.join(path, "work")
    arrays: Dict[str, Optional[Dict[str, np.ndarray]]] = {}
    longest = 0
    for st in STAGES:
        p = os.path.join(work, st + ".npz")
        if os.path.isfile(p):
            with np.load(p, allow_pickle=False) as z:
                arrays[st] = {k: np.array(z[k]) for k in z.files}
            for k, v in arrays[st].items():
                if v.ndim == 1 and v.dtype.kind == "f" and k not in ("cuts", "shot_start", "shot_end"):
                    longest = max(longest, len(v))
    dur = float(truth["media"].get("duration") or 0) or float(longest)
    n = fusion.seconds_count(dur)
    signals, cuts = fusion.assemble_signals(arrays, n)
    return {"name": os.path.basename(path.rstrip(os.sep)), "truth": sf.enforced(truth), "signals": signals,
            "cuts": cuts, "duration": dur, "n": n}


def counts(case: Dict[str, Any], cat: str, weights: Dict[str, Dict[str, float]], thr: float) -> Tuple[int, int, int]:
    levels = {c: "off" for c in config.CATEGORIES}
    levels[cat] = "strict"
    pred = fusion.fuse(case["signals"], case["cuts"], case["duration"], levels, "en-US", weights=weights,
                       thresholds={cat: thr})
    n = int(math.ceil(case["duration"]))
    ps = _seconds([r for r in pred if r["category"] == cat], n)
    ts = _seconds([r for r in case["truth"] if r["category"] == cat], n)
    return len(ts & ps), len(ps - ts), len(ts - ps)


def metrics(tp: int, fp: int, fn: int, beta: float) -> Dict[str, Optional[float]]:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = (2 * p * r / (p + r) if p + r else 0.0) if p is not None and r is not None else None
    b2 = beta * beta
    fb = ((1 + b2) * p * r / (b2 * p + r) if b2 * p + r else 0.0) if p is not None and r is not None else None
    return {"precision": p, "recall": r, "f1": f1, "fbeta": fb, "missed": fn, "false": fp}


def grid(cases: Sequence[Dict[str, Any]], cat: str, wvals: Sequence[float], tvals: Sequence[float],
         beta: float) -> List[Dict[str, Any]]:
    sigs = [s for s in config.SIGNALS if any(cat in (c["signals"].get(s) or {}) for c in cases)]
    rows = []

    def run(wmap: Dict[str, float], thr: float, label: str) -> Dict[str, Any]:
        weights = {s: dict(config.SIGNAL_WEIGHTS.get(s, {})) for s in config.SIGNALS}
        for s, w in wmap.items():
            weights[s][cat] = w
        tp = fp = fn = 0
        for c in cases:
            a, b, d = counts(c, cat, weights, thr)
            tp, fp, fn = tp + a, fp + b, fn + d
        row = {"label": label, "weights": dict(wmap), "threshold": thr}
        row.update(metrics(tp, fp, fn, beta))
        return row

    base_thr = config.LEVEL_THRESHOLDS["strict"]
    current = run({s: config.SIGNAL_WEIGHTS.get(s, {}).get(cat, 0.0) for s in sigs}, base_thr, "current (strict)")
    for combo in itertools.product(wvals, repeat=len(sigs)):
        if sigs and not any(combo):
            continue
        for thr in tvals:
            rows.append(run(dict(zip(sigs, combo)), thr, ""))
    rows.sort(key=lambda r: (-(r["fbeta"] if r["fbeta"] is not None else -1), r["missed"], r["false"],
                             r["threshold"], sorted(r["weights"].items())))
    return [current] + rows


def fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return "%.3f" % v
    return str(v)


def table(cat: str, rows: Sequence[Dict[str, Any]], top: int, beta: float) -> str:
    out = ["### %s" % cat, "",
           "| rank | weights | threshold | precision | recall | F1 | F%g | s missed | s falsely flagged |" % beta,
           "|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows[: top + 1]):
        w = ", ".join("%s=%g" % (s, v) for s, v in sorted(r["weights"].items())) or "-"
        out.append("| %s | %s | %g | %s | %s | %s | %s | %d | %d |" % (
            r["label"] or str(i), w, r["threshold"], fmt(r["precision"]), fmt(r["recall"]), fmt(r["f1"]),
            fmt(r["fbeta"]), r["missed"], r["false"]))
    return "\n".join(out)


def floats(text: str) -> List[float]:
    return [float(x) for x in text.split(",") if x.strip()]


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cases")
    ap.add_argument("--categories", default=",".join(config.VISUAL_CATEGORIES))
    ap.add_argument("--weights", default="0,0.35,0.6,0.85,1")
    ap.add_argument("--thresholds", default="0.3,0.4,0.5,0.6,0.7,0.8")
    ap.add_argument("--beta", type=float, default=2.0)
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--json", default=None)
    a = ap.parse_args(argv)
    dirs = sorted(os.path.join(a.cases, d) for d in os.listdir(a.cases)
                  if os.path.isfile(os.path.join(a.cases, d, "truth.bonis.json")))
    if not dirs:
        print("no cases (folders with truth.bonis.json + work/) in %s" % a.cases, file=sys.stderr)
        return 2
    cases = [load_case(d) for d in dirs]
    report: Dict[str, Any] = {"cases": [c["name"] for c in cases], "beta": a.beta, "categories": {}}
    print("# Fusion tuning: %d case(s): %s\n" % (len(cases), ", ".join(report["cases"])))
    for cat in [c.strip() for c in a.categories.split(",") if c.strip()]:
        if cat not in config.CATEGORIES:
            print("unknown category %s" % cat, file=sys.stderr)
            return 2
        rows = grid(cases, cat, floats(a.weights), floats(a.thresholds), a.beta)
        report["categories"][cat] = rows[: a.top + 1]
        print(table(cat, rows, a.top, a.beta))
        print()
    print("Seconds at 1 s resolution over all cases; rows ranked by F%g; row 1 = config.py today." % a.beta)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
