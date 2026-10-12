"""Python fingerprint port must match shared/fingerprint.js (expected/fingerprint.json)."""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _fixtures as F  # noqa: E402

from bonis_analyzer import fingerprint as FP  # noqa: E402


def synth(size: int, seed: int) -> bytes:
    r = F.Rng(seed)
    return bytes(r.next() & 255 for _ in range(size))


class FingerprintTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, name: str, data: bytes) -> str:
        p = os.path.join(self.tmp.name, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_hand_computed(self) -> None:
        big = bytearray(131072)
        big[0] = 1
        big[-1] = 0x80
        cases = [
            (b"", "0000000000000000"),
            (bytes([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]), "0000000000000016"),
            (b"\xff" * 8, "0000000000000006"),
            (bytes([1, 2, 3, 4, 5, 6, 7]), "000e0c0a08060409"),
            (bytes(big), "8000000000020001"),
            (bytes(200000), "0000000000030d40"),
        ]
        for i, (data, want) in enumerate(cases):
            with self.subTest(case=i):
                self.assertEqual(FP.oshash(self.write("hand%d" % i, data)), want)

    def test_matches_js_on_synthetic_files(self) -> None:
        cases = F.load("expected/fingerprint.json")
        self.assertGreaterEqual(len(cases), 10)
        for c in cases:
            with self.subTest(size=c["size"]):
                data = synth(c["size"], c["seed"])
                p = self.write("synth-%d" % c["size"], data)
                self.assertEqual(FP.fingerprint(p), {"size": c["size"], "oshash": c["oshash"], "headSha256": c["headSha256"]})
                self.assertEqual(FP.head_sha256(p), hashlib.sha256(data[:1048576]).hexdigest())

    def test_errors(self) -> None:
        with self.assertRaises(OSError):
            FP.fingerprint(os.path.join(self.tmp.name, "missing"))
        with self.assertRaises(OSError):
            FP.oshash(self.tmp.name)


if __name__ == "__main__":
    unittest.main()
