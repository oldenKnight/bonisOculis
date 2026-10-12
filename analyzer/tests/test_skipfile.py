"""The Python skip-file port must agree with shared/skipfile.js on spec/fixtures.

Run with ``python3 -m pytest analyzer/tests`` or
``python3 -m unittest discover -s analyzer/tests`` (or ``cd analyzer && python3 -m unittest``).
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _fixtures as F  # noqa: E402

from bonis_analyzer import skipfile as S  # noqa: E402

NOW = F.MANIFEST["now"]


class ValidateTest(unittest.TestCase):
    def test_valid_fixtures_validate(self) -> None:
        files = F.listing("valid")
        self.assertGreaterEqual(len(files), 6)
        for f in files:
            with self.subTest(f=f):
                self.assertEqual(S.validate(F.load(f)), {"ok": True, "errors": []})
                self.assertTrue(S.from_json(F.text(f))["ok"])

    def test_invalid_fixtures_give_the_same_errors_as_js(self) -> None:
        expected = F.load("expected/invalid-errors.json")
        files = F.listing("invalid")
        self.assertGreaterEqual(len(files), 10)
        self.assertEqual(files, sorted(expected))
        for f in files:
            with self.subTest(f=f):
                res = S.from_json(F.text(f))
                self.assertFalse(res["ok"])
                self.assertIsNone(res["doc"])
                self.assertIn(expected[f]["mustInclude"], [e["path"] for e in res["errors"]])
                self.assertEqual(res["errors"], expected[f]["errors"])

    def test_bytes_input_and_bom(self) -> None:
        raw = F.text("valid/minimal.bonis.json")
        self.assertTrue(S.from_json(raw.encode("utf-8"))["ok"])
        self.assertTrue(S.from_json("﻿" + raw)["ok"])
        self.assertEqual(S.from_json(b"\xff\xfe")["errors"], [{"path": "", "msg": "not valid JSON"}])
        self.assertEqual(S.from_json(None)["errors"], [{"path": "", "msg": "input must be a string"}])

    def test_python_specific_number_rules(self) -> None:
        d = F.load("valid/full.bonis.json")
        d["ranges"][0]["locked"] = 1          # an int is not a boolean
        d["ranges"][0]["intensity"] = True    # a bool is not an integer
        d["ranges"][1]["intensity"] = 2.0     # 2.0 is an integer, as in JSON Schema
        d["media"]["fingerprint"]["size"] = 10 ** 400   # beyond a double: not a number in JS
        self.assertEqual(S.validate(d)["errors"], [
            {"path": "/media/fingerprint/size", "msg": "must be an integer"},
            {"path": "/ranges/0/intensity", "msg": "must be an integer"},
            {"path": "/ranges/0/locked", "msg": "must be a boolean"},
        ])

    def test_versions_and_top_level_keys(self) -> None:
        d = F.load("valid/future-version.bonis.json")
        self.assertTrue(S.validate(d)["ok"])
        d["ranges"][0]["extra"] = 1
        self.assertEqual([e["path"] for e in S.validate(d)["errors"]], ["/ranges/0/extra"])
        d = F.load("valid/minimal.bonis.json")
        d["extra"] = 1
        self.assertTrue(S.validate(d)["ok"])
        for v, msg in ((0, "must be >= 1"), ("1", "must be an integer"), (1.5, "must be an integer"), (True, "must be an integer")):
            d["version"] = v
            self.assertEqual(S.validate(d)["errors"], [{"path": "/version", "msg": msg}])

    def test_summary_counts_enforced_only(self) -> None:
        out = S.normalise(F.load("valid/overlap.bonis.json"), NOW)
        self.assertEqual(out["summary"]["other"], {"count": 0, "seconds": 0, "maxIntensity": 0})
        self.assertEqual(out["summary"]["implied"], {"count": 2, "seconds": 16, "maxIntensity": 0})

    def test_history_range_id_pattern(self) -> None:
        d = F.load("valid/full.bonis.json")
        d["history"][1]["rangeId"] = "rd00011"
        d["history"][2]["rangeId"] = "x1234"
        self.assertEqual(S.validate(d)["errors"], [{"path": "/history/2/rangeId", "msg": "must match ^r[0-9a-z]{4,16}$"}])


class NormaliseTest(unittest.TestCase):
    def test_normalise_matches_js(self) -> None:
        for e in F.MANIFEST["valid"]:
            with self.subTest(f=e["fixture"]):
                doc = F.load(e["fixture"])
                before = json.dumps(doc, sort_keys=True)
                out = S.normalise(doc, NOW)
                self.assertTrue(F.same(out, F.load(e["normalised"])), e["normalised"])
                self.assertEqual(json.dumps(doc, sort_keys=True), before)
                self.assertTrue(S.validate(out)["ok"])

    def test_serialised_output_is_byte_identical_to_js(self) -> None:
        for e in F.MANIFEST["valid"]:
            with self.subTest(f=e["fixture"]):
                self.assertEqual(S.to_json(S.normalise(F.load(e["fixture"]), NOW)), F.text(e["normalised"]))
                self.assertEqual(S.to_json(S.enforced(F.load(e["fixture"]))), F.text(e["enforced"]))
                self.assertEqual(S.to_json(F.load(e["fixture"])), F.text(e["fixture"]))
        for m in F.MANIFEST["merge"]:
            self.assertEqual(S.to_json(S.merge(F.load(m["old"]), F.load(m["new"]), NOW)), F.text(m["expected"]))
        for o in F.MANIFEST["offset"]:
            self.assertEqual(S.to_json(S.apply_offset(F.load(o["fixture"]), o["seconds"], NOW)), F.text(o["expected"]))

    def test_normalise_is_idempotent(self) -> None:
        for e in F.MANIFEST["valid"]:
            once = S.normalise(F.load(e["fixture"]), NOW)
            self.assertTrue(F.same(S.normalise(once, NOW), once), e["fixture"])

    def test_enforced_matches_js(self) -> None:
        for e in F.MANIFEST["valid"]:
            with self.subTest(f=e["fixture"]):
                self.assertTrue(F.same(S.enforced(F.load(e["fixture"])), F.load(e["enforced"])))


class ExportTest(unittest.TestCase):
    def test_kodi_and_mpv_edl_byte_identical(self) -> None:
        for e in F.MANIFEST["valid"]:
            with self.subTest(f=e["fixture"]):
                doc = F.load(e["fixture"])
                self.assertEqual(S.to_kodi_edl(doc), F.text(e["kodi"]))
                self.assertEqual(S.to_mpv_edl(doc, e["mediaPath"]), F.text(e["mpv"]))

    def test_apply_offset_matches_js(self) -> None:
        for o in F.MANIFEST["offset"]:
            with self.subTest(f=o["expected"]):
                doc = F.load(o["fixture"])
                out = S.apply_offset(doc, o["seconds"], NOW)
                self.assertTrue(F.same(out, F.load(o["expected"])))
                self.assertTrue(F.same(out["ranges"], doc["ranges"]))
        with self.assertRaises(TypeError):
            S.apply_offset(F.load("valid/minimal.bonis.json"), float("nan"))

    def test_mpv_path_quoting(self) -> None:
        doc = F.load("valid/minimal.bonis.json")
        self.assertEqual(S.to_mpv_edl(doc, "a,b.mkv"), "# mpv EDL v0\n%7%a,b.mkv,0.00\n")
        self.assertEqual(S.to_mpv_edl(doc, "ñ=\U0001F3AC"), "# mpv EDL v0\n%7%ñ=\U0001F3AC,0.00\n")


class MergeTest(unittest.TestCase):
    def test_merge_matches_js(self) -> None:
        for m in F.MANIFEST["merge"]:
            old, new = F.load(m["old"]), F.load(m["new"])
            out = S.merge(old, new, NOW)
            self.assertTrue(F.same(out, F.load(m["expected"])))
            self.assertEqual(S.to_kodi_edl(out), F.text(m["kodi"]))
            self.assertTrue(F.same(old, F.load(m["old"])), "old untouched")
            self.assertTrue(F.same(new, F.load(m["new"])), "new untouched")
            self.assertTrue(S.validate(out)["ok"])

    def test_merge_scan_into_itself(self) -> None:
        old = F.load("valid/movie-3h.bonis.json")
        out = S.merge(old, old, NOW)
        self.assertTrue(S.validate(out)["ok"])
        self.assertEqual(sum(r["review"] == "rejected" for r in out["ranges"]),
                         sum(r["review"] == "rejected" for r in old["ranges"]))


class DifferentialTest(unittest.TestCase):
    def test_seeded_random_documents_agree_with_js(self) -> None:
        cases = F.load(F.MANIFEST["differential"])
        self.assertEqual(len(cases), 40)
        for i, c in enumerate(cases):
            with self.subTest(case=i):
                a, b = c["a"], c["b"]
                self.assertTrue(F.same(S.normalise(a, NOW), c["normalised"]))
                self.assertTrue(F.same(S.enforced(a), c["enforced"]))
                self.assertEqual(S.to_kodi_edl(a), c["kodi"])
                self.assertEqual(S.to_mpv_edl(a, c["mediaPath"]), c["mpv"])
                self.assertTrue(F.same(S.merge(a, b, NOW), c["merged"]))
                self.assertTrue(F.same(S.apply_offset(a, c["seconds"], NOW), c["offset"]))


class ConstructorTest(unittest.TestCase):
    def test_new_doc_and_range(self) -> None:
        d = S.new_doc({"media": {"title": "T", "duration": 10, "fingerprint": {"size": 1, "oshash": "0000000000000001"}}})
        self.assertTrue(S.validate(d)["ok"])
        self.assertRegex(d["id"], r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        self.assertEqual(d["history"], [{"at": d["created"], "event": "created"}])
        self.assertTrue(S.validate(S.new_doc())["ok"])
        ids = set()
        for _ in range(500):
            r = S.new_range({"start": 1, "end": 2, "bogus": 1})
            self.assertRegex(r["id"], r"^r[0-9a-z]{8}$")
            ids.add(r["id"])
        self.assertEqual(len(ids), 500)
        self.assertEqual(list(r), ["id", "start", "end", "category", "confidence", "action", "source", "review"])
        d["ranges"].append(r)
        self.assertTrue(S.validate(d)["ok"])

    def test_add_history_cap_and_truncation(self) -> None:
        d = S.new_doc(None, "2026-01-01T00:00:00Z")
        for i in range(2100):
            S.add_history(d, "edited", "r%d" % (10000 + i), None, "2026-01-01T00:00:00Z")
        self.assertEqual(len(d["history"]), 2000)
        self.assertEqual(d["history"][0]["rangeId"], "r10100")
        S.add_history(d, "edited", None, "\U0001F3AC" * 300)
        self.assertEqual(len(d["history"][-1]["detail"]), 200)
        self.assertTrue(S.validate(d)["ok"])
        with self.assertRaises(TypeError):
            S.add_history(d, "watched")


class FromJsonFuzzTest(unittest.TestCase):
    CHARS = '{}[]":,0123456789.-eE tfnul\\abcé\ud83c\u0000\n'

    def _check(self, res: dict, label: str) -> None:
        self.assertIsInstance(res["ok"], bool, label)
        if res["ok"]:
            self.assertEqual(res["errors"], [])
            S.normalise(res["doc"])
            S.to_kodi_edl(res["doc"])
            S.to_mpv_edl(res["doc"], "x.mkv")
        else:
            self.assertIsNone(res["doc"])
            self.assertTrue(res["errors"])
            for e in res["errors"]:
                self.assertIsInstance(e["path"], str)
                self.assertIsInstance(e["msg"], str)

    def _mutate(self, t: str, r: F.Rng) -> str:
        i, op = r.int(len(t) + 1), r.int(7)
        if op == 0:
            return t[:i] + t[i + 1:]
        if op == 1:
            return t[:i] + self.CHARS[r.int(len(self.CHARS))] + t[i:]
        if op == 2:
            return t[:i] + self.CHARS[r.int(len(self.CHARS))] + t[i + 1:]
        if op == 3:
            return t[:i]
        j = r.int(len(t) + 1)
        if op == 4:
            return t[:min(i, j)] + t[max(i, j):]
        if op == 5:
            return t[:i] + t[min(i, j):max(i, j)] + t[i:]
        return t[i:] + t[:i]

    def test_2000_text_mutations_never_raise(self) -> None:
        base = F.text("valid/full.bonis.json")
        r = F.Rng(4242)
        t = base
        for n in range(2000):
            t = base if r.int(3) == 0 else t
            t = self._mutate(t, r)
            self._check(S.from_json(t), "mutation %d" % n)

    def test_garbage(self) -> None:
        for g in ["", " ", "﻿", "NaN", '{"a": NaN}', "Infinity", "-Infinity", "[", "\u0000", "[" * 200000,
                  '"\\ud800"', "1e400", '{"__proto__": {}}', 5, {}, [], b"{}"]:
            res = S.from_json(g)
            self._check(res, repr(g)[:40])
            self.assertFalse(res["ok"])


if __name__ == "__main__":
    unittest.main()
