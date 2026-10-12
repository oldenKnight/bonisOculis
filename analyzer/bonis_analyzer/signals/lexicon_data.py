"""Locate and load the shared lexicon JSON files (spec/lexicon/<lang>.json).

Search order: $BONIS_LEXICON_DIR, the repository's spec/lexicon (development),
then <bundle>/lexicon (PyInstaller onedir, see analyzer/README.md).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List

_CACHE: Dict[str, Dict[str, Any]] = {}
_PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def candidate_dirs() -> List[str]:
    out = []
    env = os.environ.get("BONIS_LEXICON_DIR")
    if env:
        out.append(env)
    out.append(os.path.join(os.path.dirname(os.path.dirname(_PKG)), "spec", "lexicon"))
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        out.append(os.path.join(meipass, "lexicon"))
    out.append(os.path.join(_PKG, "lexicon"))
    return out


def load(lang: str) -> Dict[str, Any]:
    if lang in _CACHE:
        return _CACHE[lang]
    for d in candidate_dirs():
        p = os.path.join(d, lang + ".json")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("language") != lang or not isinstance(data.get("keywords"), list):
                raise ValueError("lexicon %s is malformed" % p)
            _CACHE[lang] = data
            return data
    raise FileNotFoundError("lexicon %s.json not found in %s" % (lang, candidate_dirs()))
