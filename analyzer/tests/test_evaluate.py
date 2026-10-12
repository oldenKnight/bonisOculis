"""evaluate.py on synthetic truth / prediction pairs with known numbers."""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import evaluate as E  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402


def doc(ranges: list, duration: float = 100) -> dict:
    return sf.new_doc({"media": {"title": "synthetic", "duration": duration,
                                 "fingerprint": {"size": 1, "oshash": "0" * 16}},
                       "ranges": [sf.new_range(dict(r, source="auto")) for r in ranges]})


TRUTH = doc([
    {"start": 10, "end": 20, "category": "nudity"},
    {"start": 50, "end": 60, "category": "gore"},
    {"start": 80, "end": 90, "category": "sex", "review": "rejected"},   # not enforced: ignored
    {"start": 92, "end": 95, "category": "implied", "action": "none"},  # not enforced: ignored
])
PRED = doc([
    {"start": 15, "end": 25, "category": "nudity"},
    {"start": 70, "end": 72, "category": "kissing"},
])


class EvaluateTest(unittest.TestCase):
    def test_known_numbers(self) -> None:
        rep = E.evaluate(TRUTH, PRED, 3.0)
        c = rep["categories"]
        self.assertEqual(sorted(c), ["all", "gore", "kissing", "nudity"])
        n = c["nudity"]
        self.assertEqual((n["truthSeconds"], n["predSeconds"], n["truePositiveSeconds"]), (10, 10, 5))
        self.assertEqual((n["precision"], n["recall"], n["f1"]), (0.5, 0.5, 0.5))
        self.assertEqual((n["rangeHitRate"], n["secondsMissed"], n["secondsFalselyFlagged"]), (1.0, 5, 5))
        g = c["gore"]
        self.assertEqual((g["precision"], g["recall"], g["f1"], g["rangeHitRate"], g["secondsMissed"]),
                         (None, 0.0, None, 0.0, 10))
        k = c["kissing"]
        self.assertEqual((k["precision"], k["recall"], k["secondsFalselyFlagged"], k["rangePrecision"]),
                         (0.0, None, 2, 0.0))
        a = c["all"]
        self.assertEqual((a["truthSeconds"], a["predSeconds"], a["truePositiveSeconds"]), (20, 12, 5))
        self.assertEqual((a["precision"], a["recall"]), (round(5 / 12, 4), 0.25))
        self.assertEqual(a["f1"], round(2 * (5 / 12 * 0.25) / (5 / 12 + 0.25), 4))

    def test_perfect_and_empty(self) -> None:
        rep = E.evaluate(TRUTH, TRUTH)
        for row in rep["categories"].values():
            self.assertEqual((row["precision"], row["recall"], row["f1"], row["rangeHitRate"]), (1.0, 1.0, 1.0, 1.0))
        rep = E.evaluate(doc([]), doc([]))
        self.assertEqual(rep["categories"]["all"]["precision"], None)

    def test_tolerance_and_fractional_seconds(self) -> None:
        truth = doc([{"start": 10, "end": 20, "category": "gore"}])
        near = doc([{"start": 22.5, "end": 30, "category": "gore"}])
        self.assertEqual(E.evaluate(truth, near, 3.0)["categories"]["gore"]["rangeHitRate"], 1.0)
        self.assertEqual(E.evaluate(truth, near, 2.0)["categories"]["gore"]["rangeHitRate"], 0.0)
        frac = doc([{"start": 10.4, "end": 12.6, "category": "gore"}])
        self.assertEqual(E.evaluate(truth, frac)["categories"]["gore"]["predSeconds"], 3)

    def test_offset_is_applied(self) -> None:
        pred = doc([{"start": 5, "end": 15, "category": "nudity"}])
        pred["media"]["offset"] = 5
        self.assertEqual(E.evaluate(TRUTH, pred)["categories"]["nudity"]["recall"], 1.0)

    def test_markdown(self) -> None:
        md = E.markdown(E.evaluate(TRUTH, PRED))
        lines = md.splitlines()
        self.assertTrue(lines[0].startswith("| category | precision | recall | F1 |"))
        self.assertIn("| nudity | 0.500 | 0.500 | 0.500 | 1.000 |", md)
        self.assertIn("| gore | - | 0.000 | - | 0.000 |", md)

    def test_cli(self) -> None:
        d = os.path.join(S.tmp_root(), "eval")
        os.makedirs(d, exist_ok=True)
        t = os.path.join(d, "truth.bonis.json")
        p = os.path.join(d, "pred.bonis.json")
        with open(t, "w", encoding="utf-8") as f:
            f.write(sf.to_json(TRUTH))
        with open(p, "w", encoding="utf-8") as f:
            f.write(sf.to_json(PRED))
        out = os.path.join(d, "report.json")
        rc, _, raw, err = S.run_cli("evaluate", "--truth", t, "--pred", p, "--tolerance", "3", "--out", out)
        self.assertEqual(rc, 0, err)
        self.assertIn("| nudity | 0.500 | 0.500 | 0.500 |", raw)
        with open(out, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["categories"]["nudity"]["f1"], 0.5)
        bad = os.path.join(d, "bad.json")
        with open(bad, "w") as f:
            f.write("{}")
        rc, lines, _, _ = S.run_cli("evaluate", "--truth", bad, "--pred", p)
        self.assertEqual((rc, lines[-1]["code"]), (2, 2))


if __name__ == "__main__":
    unittest.main()
