"""Truth vs prediction: per-category precision / recall / F1 at 1-second
resolution, range hit rate with +-tolerance, seconds missed / falsely
flagged. Both inputs are skip files; only enforced ranges count
(review != rejected, action != none), with media.offset applied.

A second i is "flagged" by a range when its midpoint i + 0.5 lies in [start, end).
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from . import skipfile as sf

CATS = ("nudity", "sex", "implied", "kissing", "gore", "language", "other")


def _seconds(ranges: Sequence[Dict[str, Any]], n: int) -> Set[int]:
    out: Set[int] = set()
    for r in ranges:
        lo = max(0, int(math.ceil(r["start"] - 0.5 - 1e-9)))
        hi = min(n, int(math.ceil(r["end"] - 0.5 - 1e-9)))
        out.update(range(lo, hi))
    return out


def _ratio(a: int, b: int) -> Optional[float]:
    return round(a / b, 4) if b else None


def _f1(p: Optional[float], r: Optional[float]) -> Optional[float]:
    if p is None or r is None or p + r == 0:
        return None if p is None or r is None else 0.0
    return round(2 * p * r / (p + r), 4)


def _overlaps(r: Dict[str, Any], others: Sequence[Dict[str, Any]], tol: float) -> bool:
    return any(o["start"] < r["end"] + tol and o["end"] > r["start"] - tol for o in others)


def _load(doc_or_path: Any) -> Dict[str, Any]:
    if isinstance(doc_or_path, dict):
        doc = doc_or_path
    else:
        with open(doc_or_path, "rb") as f:
            res = sf.from_json(f.read())
        if not res["ok"]:
            raise ValueError("%s is not a valid skip file: %s" % (doc_or_path, res["errors"][:3]))
        doc = res["doc"]
    return doc


def evaluate(truth: Any, pred: Any, tolerance: float = 3.0) -> Dict[str, Any]:
    t, p = _load(truth), _load(pred)
    tr, pr = sf.enforced(t), sf.enforced(p)
    dur = max([float(t["media"].get("duration") or 0), float(p["media"].get("duration") or 0)]
              + [r["end"] for r in tr + pr] + [0.0])
    n = int(math.ceil(dur))
    rows: Dict[str, Dict[str, Any]] = {}
    cats = [c for c in CATS if any(r["category"] == c for r in tr + pr)]
    for c in cats + ["all"]:
        tc = [r for r in tr if c == "all" or r["category"] == c]
        pc = [r for r in pr if c == "all" or r["category"] == c]
        ts, ps = _seconds(tc, n), _seconds(pc, n)
        tp = len(ts & ps)
        prec, rec = _ratio(tp, len(ps)), _ratio(tp, len(ts))
        hits = sum(1 for r in tc if _overlaps(r, pc, tolerance))
        good = sum(1 for r in pc if _overlaps(r, tc, tolerance))
        rows[c] = {
            "truthSeconds": len(ts), "predSeconds": len(ps), "truePositiveSeconds": tp,
            "precision": prec, "recall": rec, "f1": _f1(prec, rec),
            "truthRanges": len(tc), "predRanges": len(pc),
            "rangeHitRate": _ratio(hits, len(tc)), "rangePrecision": _ratio(good, len(pc)),
            "secondsMissed": len(ts - ps), "secondsFalselyFlagged": len(ps - ts),
        }
    return {"tolerance": tolerance, "durationSeconds": n, "categories": rows}


def _fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return "%.3f" % v
    return str(v)


def markdown(report: Dict[str, Any]) -> str:
    cols = [("category", None), ("precision", "precision"), ("recall", "recall"), ("F1", "f1"),
            ("range hit rate", "rangeHitRate"), ("truth ranges", "truthRanges"), ("pred ranges", "predRanges"),
            ("s missed", "secondsMissed"), ("s falsely flagged", "secondsFalselyFlagged")]
    lines = ["| " + " | ".join(c for c, _ in cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for cat, row in report["categories"].items():
        lines.append("| " + " | ".join([cat] + [_fmt(row[k]) for _, k in cols[1:]]) + " |")
    lines.append("")
    lines.append("1-second resolution; range hit rate uses a tolerance of +-%g s." % report["tolerance"])
    return "\n".join(lines)


def run(truth_path: str, pred_path: str, tolerance: float, out: Optional[str]) -> Tuple[Dict[str, Any], str]:
    rep = evaluate(truth_path, pred_path, tolerance)
    md = markdown(rep)
    if out:
        from .output import write_atomic  # noqa: PLC0415

        write_atomic(out, json.dumps(rep, indent=1) + "\n")
    return rep, md


__all__: List[str] = ["evaluate", "markdown", "run"]
