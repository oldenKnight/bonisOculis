"""output.py: document building, atomic write, merge with an existing file."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support  # noqa: E402, F401

from bonis_analyzer import output  # noqa: E402
from bonis_analyzer import skipfile as sf  # noqa: E402

MEDIA = {"path": "/films/A Movie (1999).mkv", "duration": 5400.25, "title": ""}
FP = {"size": 123456, "oshash": "0123456789abcdef", "headSha256": "a" * 64}


def ranges() -> list:
    return [{"id": "rabcdef0001", "start": 10, "end": 20, "category": "nudity", "confidence": 0.9, "intensity": 3,
             "action": "skip", "source": "auto", "review": "pending", "signals": {"frames": 0.9},
             "note": "Possible nudity. Seen in the picture.", "cutStart": 12},
            {"id": "rabcdef0002", "start": 15, "end": 30, "category": "language", "confidence": 0.9,
             "action": "mute", "source": "auto", "review": "pending"}]


class OutputTest(unittest.TestCase):
    def build(self, status: str = "complete") -> dict:
        return output.build_doc(MEDIA, FP, [12.0, 30.5, 30.5], ranges(), "es-MX", {"nudity": "strict"},
                                {"frames": {"status": "done", "progress": 1, "seconds": 3.14159, "resumeAt": None,
                                            "framesThisRun": 3}, "audio": {"status": "skipped"}},
                                status, ["w"], "2026-10-12T00:00:00.000Z", "2026-10-12T01:00:00.000Z", "cpu")

    def test_build_doc_is_valid(self) -> None:
        d = self.build()
        self.assertTrue(sf.validate(d)["ok"], sf.validate(d)["errors"])
        self.assertEqual(d["media"]["title"], "A Movie (1999)")
        self.assertEqual(d["media"]["fingerprint"]["sceneCuts"], [12.0, 30.5])
        self.assertEqual(d["scan"]["stages"]["frames"], {"status": "done", "progress": 1, "seconds": 3.1})
        self.assertEqual(d["summary"]["nudity"]["count"], 1)
        self.assertEqual([e["event"] for e in d["history"]], ["created", "scanned"])

    def test_write_atomic_and_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sub", "m.bonis.json")
            first = output.write_skipfile(path, self.build())
            self.assertEqual(os.listdir(os.path.dirname(path)), ["m.bonis.json"])
            with open(path, "rb") as f:
                res = sf.from_json(f.read())
            self.assertTrue(res["ok"])
            res["doc"]["ranges"][0]["locked"] = True
            res["doc"]["ranges"][0]["end"] = 22
            with open(path, "w", encoding="utf-8") as f:
                f.write(sf.to_json(res["doc"]))
            second = output.write_skipfile(path, self.build())
            self.assertEqual(second["id"], first["id"])
            locked = [r for r in second["ranges"] if r.get("locked")]
            self.assertEqual([(r["start"], r["end"]) for r in locked], [(10, 22)])


if __name__ == "__main__":
    unittest.main()
