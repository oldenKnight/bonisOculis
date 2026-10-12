"""tools/tune.py on synthetic score streams with a planted truth: two cases,
each a hand-marked skip file plus a work dir of stage .npz files. The planted
signals are built so that the current weights miss part of the truth and a
better grid point exists; tune.py must find it and print one markdown table
per category."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer import skipfile as sf  # noqa: E402

TUNE = os.path.join(S.ROOT, "tools", "tune.py")
N = 600


def write_case(root: str, name: str, truth: list, seed: int) -> None:
    rng = np.random.default_rng(seed)
    d = os.path.join(root, name)
    w = os.path.join(d, "work")
    os.makedirs(w)
    frames = {c: (rng.random(N) * 0.12).astype(np.float32) for c in ("nudity", "sex", "implied", "kissing", "gore")}
    audio = {c: np.zeros(N, np.float32) for c in ("sex", "implied", "gore")}
    for cat, a, b in truth:
        if cat == "sex":
            frames["sex"][a:b] = 0.38          # weak picture evidence: 0.9 * 0.38 = 0.34 < strict 0.4
            audio["sex"][a:b - 5] = 0.45       # sounds through most of it
        if cat == "gore":
            frames["gore"][a:b] = 0.6
    frames["gore"][500:504] = 0.6              # one false alarm in the picture (not in the truth)
    np.savez(os.path.join(w, "frames.npz"), cuts=np.asarray([], np.float64), **frames)
    np.savez(os.path.join(w, "audio.npz"), **audio)
    doc = sf.new_doc({"media": {"title": name, "duration": N, "fingerprint": {"size": 1, "oshash": "0" * 16}},
                      "ranges": [sf.new_range({"start": float(a), "end": float(b), "category": c, "source": "manual",
                                               "review": "approved"}) for c, a, b in truth]})
    with open(os.path.join(d, "truth.bonis.json"), "w", encoding="utf-8") as f:
        f.write(sf.to_json(sf.normalise(doc)))


class TuneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = os.path.join(S.tmp_root(), "tune-cases")
        shutil.rmtree(cls.root, ignore_errors=True)
        os.makedirs(cls.root)
        write_case(cls.root, "film-a", [("sex", 100, 130), ("gore", 250, 260)], 1)
        write_case(cls.root, "film-b", [("sex", 300, 340)], 2)

    def run_tune(self, *args: str) -> str:
        res = subprocess.run([sys.executable, TUNE, self.root] + list(args), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr.decode()[-2000:])
        return res.stdout.decode()

    def rows(self, out: str, cat: str) -> list:
        sec = out.split("### " + cat)[1].split("###")[0]
        return [[c.strip() for c in ln.strip("|").split("|")] for ln in sec.splitlines() if ln.startswith("| ")][1:]

    def test_finds_better_weights_and_prints_tables(self) -> None:
        js = os.path.join(self.root, "..", "tune.json")
        out = self.run_tune("--categories", "sex,gore", "--weights", "0,0.6,0.9", "--thresholds", "0.3,0.4,0.5",
                            "--top", "3", "--json", js)
        self.assertIn("# Fusion tuning: 2 case(s): film-a, film-b", out)
        self.assertIn("| rank | weights | threshold | precision | recall | F1 | F2 | s missed | s falsely flagged |", out)
        sex = self.rows(out, "sex")
        self.assertEqual(sex[0][0], "current (strict)")
        self.assertEqual(len(sex), 4)
        cur_recall, best_recall = float(sex[0][4]), float(sex[1][4])
        self.assertLess(cur_recall, 1.0)              # today's weights miss the quiet tail of the scene
        self.assertGreater(best_recall, cur_recall)
        self.assertGreaterEqual(float(sex[1][6]), float(sex[0][6]))   # best F2 >= current
        self.assertLess(int(sex[1][7]), int(sex[0][7]))               # fewer seconds missed
        gore = self.rows(out, "gore")
        self.assertEqual(float(gore[1][4]), 1.0)      # the planted gore range is found
        self.assertGreater(int(gore[1][8]), 0)        # ... with the planted false alarm counted
        with open(js, encoding="utf-8") as f:
            rep = json.load(f)
        self.assertEqual(rep["cases"], ["film-a", "film-b"])
        self.assertEqual(sorted(rep["categories"]), ["gore", "sex"])
        self.assertEqual(rep["categories"]["sex"][1]["recall"], best_recall)
        self.assertTrue(re.search(r"weights \| threshold", out))

    def test_deterministic(self) -> None:
        a = self.run_tune("--categories", "sex", "--weights", "0,0.9", "--thresholds", "0.4")
        b = self.run_tune("--categories", "sex", "--weights", "0,0.9", "--thresholds", "0.4")
        self.assertEqual(a, b)

    def test_no_cases(self) -> None:
        empty = os.path.join(S.tmp_root(), "tune-empty")
        os.makedirs(empty, exist_ok=True)
        res = subprocess.run([sys.executable, TUNE, empty], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main()
