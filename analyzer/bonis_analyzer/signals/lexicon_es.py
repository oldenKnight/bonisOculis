"""Spanish (es-MX first) lexicon: thin loader of spec/lexicon/es.json."""

from __future__ import annotations

from typing import Any, Dict

from .lexicon_data import load


def lexicon() -> Dict[str, Any]:
    return load("es")
