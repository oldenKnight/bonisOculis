"""Shared fixture access for the analyzer tests (spec/fixtures)."""

from __future__ import annotations

import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
ANALYZER = os.path.dirname(HERE)
ROOT = os.path.join(os.path.dirname(ANALYZER), "spec", "fixtures")

if ANALYZER not in sys.path:
    sys.path.insert(0, ANALYZER)


def text(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8", newline="") as f:
        return f.read()


def load(rel: str) -> Any:
    return json.loads(text(rel))


def listing(directory: str) -> list[str]:
    return sorted(directory + "/" + f for f in os.listdir(os.path.join(ROOT, directory)) if f.endswith(".json"))


MANIFEST = load("expected/manifest.json")


class Rng:
    """Park-Miller generator, identical to tools/make-fixtures.js and the JS tests."""

    def __init__(self, seed: int) -> None:
        self.x = seed

    def next(self) -> int:
        self.x = (self.x * 48271) % 2147483647
        return self.x

    def int(self, n: int) -> int:
        return self.next() % n


def same(a: Any, b: Any) -> bool:
    """Strict JSON equality: 1 == 1.0, but booleans never equal numbers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b
