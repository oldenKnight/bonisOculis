"""English lexicon: thin loader of spec/lexicon/en.json (shared with the extension)."""

from __future__ import annotations

from typing import Any, Dict

from .lexicon_data import load


def lexicon() -> Dict[str, Any]:
    return load("en")
