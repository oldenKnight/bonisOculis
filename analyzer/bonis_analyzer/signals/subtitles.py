"""Subtitles signal: find a track (embedded or sidecar), convert to SRT with
ffmpeg (in memory, never on disk), parse, and score cues with the shared
lexicons (spec/lexicon, matching rules in spec/lexicon/README.md).

Output: per-second float arrays per category (index i covers [i, i+1)).
"""

from __future__ import annotations

import html
import math
import os
import re
import subprocess
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from .. import config
from ..pipeline.tools import popen_kwargs, tool
from . import lexicon_en, lexicon_es

Cue = Dict[str, Any]  # {"start": float, "end": float, "text": str}

# --------------------------------------------------------------------------
# SRT parsing
# --------------------------------------------------------------------------

_T = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.:](\d{1,3}))?"
_TIMING = re.compile(r"^\s*" + _T + r"\s*-+>\s*" + _T)
_TAG = re.compile(r"<[^>]*>")
_ASS = re.compile(r"\{\\[^}]*\}")
_DIGITS = re.compile(r"^\s*\d+\s*$")


def _secs(h: Optional[str], m: str, s: str, ms: Optional[str]) -> float:
    frac = int(ms.ljust(3, "0")) / 1000.0 if ms else 0.0
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + frac


def _clean(lines: List[str]) -> str:
    t = "\n".join(lines)
    t = _ASS.sub("", t)
    t = _TAG.sub("", t)
    t = html.unescape(t).replace("\\N", "\n").replace("\\n", "\n")
    out = [ln.strip() for ln in t.split("\n")]
    return "\n".join(ln for ln in out if ln)


def parse_srt(text: str) -> List[Cue]:
    """Robust SRT parser: BOM, CRLF/CR, missing blank lines or indices,
    dot or comma milliseconds, overlapping cues, HTML/ASS tags stripped.
    Returns cues sorted by (start, end); empty cues dropped."""
    if isinstance(text, bytes):
        text = decode_text(text)
    text = text.replace("﻿", "").replace("\r\n", "\n").replace("\r", "\n")
    cues: List[Cue] = []
    cur: Optional[Dict[str, Any]] = None

    def finish(c: Optional[Dict[str, Any]], before_timing: bool) -> None:
        if c is None:
            return
        lines = c["lines"]
        if before_timing and lines and _DIGITS.match(lines[-1]):
            lines = lines[:-1]  # index of the next cue (blank line missing)
        body = _clean(lines)
        if body:
            start, end = c["start"], c["end"]
            if end <= start:
                end = start + 1.0
            cues.append({"start": round(start, 3), "end": round(end, 3), "text": body})

    for line in text.split("\n"):
        m = _TIMING.match(line)
        if m:
            finish(cur, True)
            g = m.groups()
            cur = {"start": _secs(g[0], g[1], g[2], g[3]), "end": _secs(g[4], g[5], g[6], g[7]), "lines": []}
        elif cur is not None and line.strip():
            cur["lines"].append(line.strip())
    finish(cur, False)
    cues.sort(key=lambda c: (c["start"], c["end"]))
    return cues


def decode_text(b: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            s = b.decode(enc)
            if enc == "utf-16" and not (b[:2] in (b"\xff\xfe", b"\xfe\xff")):
                continue
            return s
        except UnicodeDecodeError:
            continue
    return b.decode("cp1252", "replace")


# --------------------------------------------------------------------------
# lexicon scoring (spec/lexicon/README.md)
# --------------------------------------------------------------------------

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_SDH = re.compile(r"\[([^\]]*)\]|\(([^)]*)\)")


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(ch for ch in s if not ("̀" <= ch <= "ͯ"))
    return _NON_ALNUM.sub(" ", s).strip()


class Lexicon:
    """Compiled lexicon: (kind, needle, category, weight) entries in file order."""

    def __init__(self, data: Dict[str, Any]) -> None:
        self.language = data["language"]
        self.ignore = list(data.get("ignore") or [])
        self.sdh = [(fold(e["pattern"]), e["category"], float(e["weight"])) for e in data.get("sdh") or []]
        self.keywords = []
        for e in data.get("keywords") or []:
            term = fold(e["term"])
            needle = " " + term if e.get("stem") else " " + term + " "
            self.keywords.append((needle, e["category"], float(e["weight"])))
        self.profanity = [(" " + fold(e["term"]) + " ", "language", float(e["weight"]))
                          for e in data.get("profanity") or []]

    def cue_text(self, text: str) -> str:
        """Cue text with ignored lines (song lyrics etc.) removed."""
        return "\n".join(ln for ln in text.split("\n") if not any(ig in ln for ig in self.ignore))

    def score_text(self, text: str) -> Dict[str, float]:
        """Per-category noisy-OR score of one cue's text."""
        text = self.cue_text(text)
        segments = [fold(a or b or "") for a, b in _SDH.findall(text)]
        dialogue = " " + fold(_SDH.sub(" ", text)) + " "
        keep: Dict[str, float] = {}
        matched: List[Tuple[str, float]] = []
        for needle, cat, w in self.sdh:
            if needle and any(needle in seg for seg in segments):
                matched.append((cat, w))
        for needle, cat, w in self.keywords:
            if needle.strip() and needle in dialogue:
                matched.append((cat, w))
        for needle, cat, w in self.profanity:
            if needle.strip() and needle in dialogue:
                matched.append((cat, w))
        for cat, w in matched:
            keep[cat] = keep.get(cat, 1.0) * (1.0 - w)
        return {c: 1.0 - v for c, v in keep.items()}


_LEXICONS: Dict[str, Lexicon] = {}


def get_lexicon(lang: str) -> Lexicon:
    key = "es" if lang_family(lang) == "es" else "en"
    if key not in _LEXICONS:
        _LEXICONS[key] = Lexicon(lexicon_es.lexicon() if key == "es" else lexicon_en.lexicon())
    return _LEXICONS[key]


def lang_family(tag: str) -> str:
    """"es-MX" / "spa" / "Spanish" -> "es"; "en-US" / "eng" -> "en"; else ""."""
    t = (tag or "").strip().lower().replace("_", "-")
    head = t.split("-")[0].split(".")[0]
    if head in ("es", "spa", "esp", "spanish", "espanol", "español", "castellano", "latino", "lat"):
        return "es"
    if head in ("en", "eng", "english", "ingles", "inglés"):
        return "en"
    return ""


_FUNC = {
    "en": {"the", "you", "and", "to", "is", "what", "that", "it", "i", "of", "this", "are", "don"},
    "es": {"que", "de", "no", "el", "la", "es", "y", "en", "lo", "por", "los", "se", "una", "pero"},
}


def guess_language(cues: Sequence[Cue], prefer: str) -> str:
    counts = {"en": 0, "es": 0}
    for c in cues[:400]:
        for w in fold(c["text"]).split():
            for k in counts:
                if w in _FUNC[k]:
                    counts[k] += 1
    if counts["en"] == counts["es"]:
        return lang_family(prefer) or "en"
    return "en" if counts["en"] > counts["es"] else "es"


def seconds_count(duration: float) -> int:
    return max(1, int(math.ceil(max(0.0, duration) - 1e-9)))


def score_cues(cues: Sequence[Cue], lexicon: Lexicon, duration: Optional[float] = None,
               categories: Iterable[str] = config.CATEGORIES) -> Dict[str, np.ndarray]:
    """Per-second float64 arrays per category (max over covering cues)."""
    if duration is None or duration <= 0:
        duration = max((c["end"] for c in cues), default=0.0)
    n = seconds_count(duration)
    out = {c: np.zeros(n, dtype=np.float64) for c in categories}
    for cue in cues:
        sc = lexicon.score_text(cue["text"])
        if not sc:
            continue
        a = int(math.floor(cue["start"]))
        b = max(a, int(math.ceil(cue["end"])) - 1)
        a, b = min(a, n - 1), min(b, n - 1)
        for cat, v in sc.items():
            if cat in out and v > 0:
                seg = out[cat][a:b + 1]
                np.maximum(seg, v, out=seg)
    return out


def round3(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000


# --------------------------------------------------------------------------
# finding and extracting a track
# --------------------------------------------------------------------------

SIDECAR_EXT = (".srt", ".vtt", ".ass", ".ssa")


def find_sidecars(media_path: str) -> List[Dict[str, Any]]:
    """<basename>.srt/.vtt/.ass/.ssa and <basename>.<tag>.<ext> next to the media."""
    folder = os.path.dirname(os.path.abspath(media_path))
    base = os.path.splitext(os.path.basename(media_path))[0]
    out = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return out
    for name in names:
        stem, ext = os.path.splitext(name)
        if ext.lower() not in SIDECAR_EXT:
            continue
        if stem == base:
            tag = ""
        elif stem.startswith(base + "."):
            tag = stem[len(base) + 1:]
        else:
            continue
        low = tag.lower()
        lang = ""
        for part in low.split("."):
            lang = lang or lang_family(part)
        out.append({
            "kind": "sidecar", "path": os.path.join(folder, name), "ext": ext.lower(), "tag": tag,
            "language": lang, "forced": "forced" in low, "hearingImpaired": any(k in low for k in ("sdh", "cc", "hi")),
        })
    return out


def candidates(media: Dict[str, Any], media_path: str) -> List[Dict[str, Any]]:
    out = []
    for s in media.get("subtitles") or []:
        out.append({"kind": "embedded", "subIndex": s["subIndex"], "codec": s["codec"],
                    "language": lang_family(s.get("language") or "") or (s.get("language") or ""),
                    "forced": s["forced"], "hearingImpaired": s["hearingImpaired"], "textBased": s["textBased"]})
    out.extend(find_sidecars(media_path))
    return out


def choose(cands: List[Dict[str, Any]], lang: str) -> List[Dict[str, Any]]:
    """Rank readable tracks: preferred language, then unknown-language sidecars,
    then the other lexicon language, then anything; non-forced, SDH and
    sidecars (the parent put them there) first within a rank."""
    pref = lang_family(lang)

    def key(ic: Tuple[int, Dict[str, Any]]) -> Tuple[Any, ...]:
        i, c = ic
        lf = lang_family(c.get("language") or "")
        if pref and lf == pref:
            rank = 0
        elif not c.get("language"):
            rank = 1 if c["kind"] == "sidecar" else 2
        elif lf in ("en", "es"):
            rank = 3
        else:
            rank = 4
        return (rank, c.get("forced", False), not c.get("hearingImpaired", False), c["kind"] != "sidecar", i)

    readable = [c for c in cands if c["kind"] == "sidecar" or c.get("textBased")]
    return [c for _, c in sorted(enumerate(readable), key=key)]


def _ffmpeg_to_srt(args: List[str], timeout: float = 300) -> str:
    cmd = [tool("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error"] + args + ["-f", "srt", "pipe:1"]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                         timeout=timeout, **popen_kwargs())
    if res.returncode != 0:
        raise RuntimeError(res.stderr.decode("utf-8", "replace").strip()[-300:] or "ffmpeg failed")
    return decode_text(res.stdout)


def extract(cand: Dict[str, Any], media_path: str) -> List[Cue]:
    """Cues of one candidate. Everything stays in memory (stdout pipe)."""
    if cand["kind"] == "embedded":
        text = _ffmpeg_to_srt(["-i", media_path, "-map", "0:s:%d" % cand["subIndex"]])
    elif cand["ext"] == ".srt":
        with open(cand["path"], "rb") as f:
            text = decode_text(f.read())
        cues = parse_srt(text)
        if cues:
            return cues
        text = _ffmpeg_to_srt(["-i", cand["path"]])
    else:
        text = _ffmpeg_to_srt(["-i", cand["path"]])
    return parse_srt(text)


def load_best(media: Dict[str, Any], media_path: str, lang: str, warn: Any = None) -> Tuple[List[Cue], Optional[Dict[str, Any]]]:
    """Cues of the best readable track, or ([], None)."""
    cands = candidates(media, media_path)
    if warn and any(c["kind"] == "embedded" and not c.get("textBased") for c in cands) and not choose(cands, lang):
        warn("This movie only has picture-based subtitles, which cannot be read yet; dialogue was not checked.")
    for c in choose(cands, lang):
        try:
            cues = extract(c, media_path)
        except Exception as e:  # noqa: BLE001 - try the next track
            if warn:
                warn("A subtitle track could not be read (%s); trying another." % (str(e)[:120],))
            continue
        if cues:
            return cues, c
    return [], None


def window_texts(cues: Sequence[Cue], lexicon: Lexicon, start: float, length: float, max_chars: int) -> str:
    """Dialogue of cues starting in [start, start+length), ignored lines removed."""
    parts = []
    total = 0
    for c in cues:
        if c["start"] < start:
            continue
        if c["start"] >= start + length:
            break
        t = lexicon.cue_text(c["text"]).replace("\n", " ").strip()
        if not t:
            continue
        if total + len(t) > max_chars:
            break
        parts.append(t)
        total += len(t) + 1
    return "\n".join(parts)


def fixture_scores(path: str, duration: Optional[float] = None) -> Dict[str, Any]:
    """Expected-scores document for a spec/fixtures/subtitles/*.srt file (the
    JS port asserts the same numbers). Lexicon from the file name tag."""
    with open(path, "rb") as f:
        cues = parse_srt(decode_text(f.read()))
    name = os.path.basename(path)
    tag = name.rsplit(".", 2)[-2] if name.count(".") >= 2 else ""
    lang = lang_family(tag) or guess_language(cues, "en")
    lex = get_lexicon(lang)
    arrays = score_cues(cues, lex, duration)
    n = len(next(iter(arrays.values())))
    return {
        "file": name,
        "lexicon": lex.language,
        "seconds": n,
        "cues": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in cues],
        "scores": {c: [round3(float(v)) for v in arrays[c]] for c in config.CATEGORIES},
    }
