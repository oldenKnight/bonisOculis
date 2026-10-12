"""bonis oculis skip-file library: Python port of shared/skipfile.js.

Contract: spec/SKIPFILE.md and spec/skipfile.schema.json. This module and
shared/skipfile.js must agree on every fixture in spec/fixtures (validator
errors, normalise, enforced, merge, offsets and both EDL exports); change
them together. Standard library only, no I/O.

Functions that create timestamps take an optional ``now`` (ISO date-time
string) so results are reproducible in tests and fixtures.

Results mirror the JavaScript shapes: ``validate`` returns
``{"ok": bool, "errors": [{"path": str, "msg": str}]}`` and ``from_json``
returns ``{"ok": bool, "doc": dict | None, "errors": [...]}``.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

FORMAT = "bonis-oculis-skip"
VERSION = 1
LIB_VERSION = "0.1.0"
APP_NAME = "bonis oculis"
MAX_HISTORY = 2000
MAX_ERRORS = 100

CATEGORIES = ("nudity", "sex", "implied", "kissing", "gore", "language", "other")
ACTIONS = ("skip", "hide", "blur", "mute", "none")
VISUAL_ACTIONS = ("skip", "hide", "blur")
SOURCES = ("auto", "manual", "panic", "imported")
REVIEWS = ("pending", "approved", "rejected")
LEVELS = ("off", "light", "moderate", "strict")
SCAN_STATUS = ("none", "partial", "complete")
STAGE_NAMES = ("subtitles", "frames", "audio", "speech", "captions", "fusion")
STAGE_STATUS = ("pending", "running", "done", "skipped", "failed")
SIGNALS = ("frames", "subtitles", "audio", "speech", "captions")
HISTORY_EVENTS = (
    "created", "scanned", "approved", "rejected", "edited", "added",
    "deleted", "imported", "exported", "panic", "offsetChanged",
)
ACTION_STRENGTH = {"skip": 4, "hide": 3, "blur": 2, "mute": 1, "none": 0}

P_UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
P_OSHASH = "^[0-9a-f]{16}$"
P_SHA256 = "^[0-9a-f]{64}$"
P_LANGUAGE = "^[a-z]{2}(-[A-Z]{2})?$"
P_RANGE_ID = "^r[0-9a-z]{4,16}$"
P_SUMMARY_KEY = "^(nudity|sex|implied|kissing|gore|language|other)$"
P_LEVEL_KEY = "^(nudity|sex|implied|kissing|gore|language)$"
RE_DATE_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?"
    r"([Zz]|[+-]([0-9]{2}):([0-9]{2}))"
)
BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

Doc = dict[str, Any]
Range = dict[str, Any]
Interval = list[float]
Errors = list[dict[str, str]]

# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def _is_object(v: Any) -> bool:
    return isinstance(v, dict)


def _is_array(v: Any) -> bool:
    return isinstance(v, list)


def _is_number(v: Any) -> bool:
    """A finite JSON number (bools are not numbers, as in JavaScript)."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        try:
            float(v)
        except OverflowError:
            return False
        return True
    if isinstance(v, float):
        return math.isfinite(v)
    return False


def _is_integer(v: Any) -> bool:
    return _is_number(v) and (isinstance(v, int) or float(v).is_integer())


def _num(v: Any) -> float:
    return v if _is_number(v) else 0


def _sid(v: Any) -> str:
    """String form of an id, like JavaScript String()."""
    if isinstance(v, str):
        return v
    if v is None:
        return "undefined"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _truthy(v: Any) -> bool:
    """JavaScript truthiness for JSON values."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    if isinstance(v, str):
        return v != ""
    return True


def _utf8_length(s: str) -> int:
    return len(s.encode("utf-8", "surrogatepass"))


def _now_iso(now: str | None = None) -> str:
    if isinstance(now, str):
        return now
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def _floor_cs(x: float) -> int:
    """Seconds -> integer centiseconds, rounded down (start of a cut)."""
    return math.floor(x * 100 + 1e-4)


def _ceil_cs(x: float) -> int:
    """Seconds -> integer centiseconds, rounded up (end of a cut)."""
    return math.ceil(x * 100 - 1e-4)


def _fmt_cs(n: int) -> str:
    i, f = divmod(n, 100)
    return "%d.%02d" % (i, f)


def _fmt_seconds(x: float) -> str:
    sign = "-" if x < 0 else ""
    ms = math.floor(abs(x) * 1000 + 0.5)
    i, f = divmod(ms, 1000)
    if ms == 0:
        return "0"
    if f == 0:
        return "%s%d" % (sign, i)
    return "%s%d.%s" % (sign, i, ("%03d" % f).rstrip("0"))


def _round3(x: float) -> float:
    return math.floor(x * 1000 + 0.5) / 1000


# --------------------------------------------------------------------------
# randomness: uuid v4 and range ids
# --------------------------------------------------------------------------


def uuid4() -> str:
    return str(uuid.uuid4())


def _range_id() -> str:
    out = "r"
    while len(out) < 9:
        for b in os.urandom(16):
            if b < 252 and len(out) < 9:
                out += BASE36[b % 36]
    return out


def _to_base36(k: int) -> str:
    s = ""
    while True:
        k, d = divmod(k, 36)
        s = BASE36[d] + s
        if k == 0:
            return s


def _derive_id(base: Any, used: set[str]) -> str:
    """Deterministic unique id derived from ``base`` (split pieces, collisions)."""
    base = _sid(base)
    k = 1
    while True:
        suffix = _to_base36(k)
        stem = base
        if len(stem) + len(suffix) > 17:
            stem = stem[: 17 - len(suffix)]
        cand = stem + suffix
        if cand not in used:
            return cand
        k += 1


# --------------------------------------------------------------------------
# validator (hand-written, mirrors skipfile.schema.json and skipfile.js)
# --------------------------------------------------------------------------

Checker = Callable[[Errors, Any, str], None]


def _add_err(errors: Errors, path: str, msg: str) -> None:
    if len(errors) < MAX_ERRORS:
        errors.append({"path": path, "msg": msg})


def _ptr(base: str, key: Any) -> str:
    return base + "/" + _sid(key).replace("~", "~0").replace("/", "~1")


def _v_string(max_len: int | None, pattern: str | None) -> Checker:
    rx = re.compile(pattern) if pattern else None

    def check(errors: Errors, v: Any, path: str) -> None:
        if not isinstance(v, str):
            _add_err(errors, path, "must be a string")
            return
        if max_len is not None and len(v) > max_len:
            _add_err(errors, path, "must be at most %d characters" % max_len)
        if rx is not None and not rx.fullmatch(v):
            _add_err(errors, path, "must match " + pattern)  # type: ignore[operator]

    return check


def _v_number(lo: int | None, hi: int | None) -> Checker:
    def check(errors: Errors, v: Any, path: str) -> None:
        if not _is_number(v):
            _add_err(errors, path, "must be a number")
            return
        if lo is not None and v < lo:
            _add_err(errors, path, "must be >= %d" % lo)
        if hi is not None and v > hi:
            _add_err(errors, path, "must be <= %d" % hi)

    return check


def _v_integer(lo: int | None, hi: int | None) -> Checker:
    def check(errors: Errors, v: Any, path: str) -> None:
        if not _is_integer(v):
            _add_err(errors, path, "must be an integer")
            return
        if lo is not None and v < lo:
            _add_err(errors, path, "must be >= %d" % lo)
        if hi is not None and v > hi:
            _add_err(errors, path, "must be <= %d" % hi)

    return check


def _v_enum(values: Iterable[str]) -> Checker:
    allowed = tuple(values)
    msg = "must be one of: " + ", ".join(allowed)

    def check(errors: Errors, v: Any, path: str) -> None:
        if not isinstance(v, str) or v not in allowed:
            _add_err(errors, path, msg)

    return check


def _v_boolean(errors: Errors, v: Any, path: str) -> None:
    if not isinstance(v, bool):
        _add_err(errors, path, "must be a boolean")


def _days_in_month(y: int, m: int) -> int:
    if m == 2:
        return 29 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 28
    return 30 if m in (4, 6, 9, 11) else 31


def _is_date_time(v: str) -> bool:
    m = RE_DATE_TIME.fullmatch(v)
    if not m:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if mo < 1 or mo > 12 or d < 1 or d > _days_in_month(y, mo):
        return False
    if int(m.group(4)) > 23 or int(m.group(5)) > 59 or int(m.group(6)) > 60:
        return False
    if m.group(9) and (int(m.group(9)) > 23 or int(m.group(10)) > 59):
        return False
    return True


def _v_date_time(errors: Errors, v: Any, path: str) -> None:
    if not isinstance(v, str):
        _add_err(errors, path, "must be a string")
        return
    if not _is_date_time(v):
        _add_err(errors, path, "must be an RFC 3339 date-time")


def _v_array(max_items: int | None, item: Checker) -> Checker:
    def check(errors: Errors, v: Any, path: str) -> None:
        if not isinstance(v, list):
            _add_err(errors, path, "must be an array")
            return
        if max_items is not None and len(v) > max_items:
            _add_err(errors, path, "must have at most %d items" % max_items)
        for i, x in enumerate(v):
            item(errors, x, _ptr(path, i))

    return check


class _ObjectSpec:
    """Object rule: required keys, known properties, optional pattern keys."""

    def __init__(self, order: Iterable[str], props: dict[str, Checker], required: Iterable[str] = (),
                 pattern: str | None = None, pattern_fn: Checker | None = None) -> None:
        self.order = tuple(order)
        self.props = props
        self.required = tuple(required)
        self.rx = re.compile(pattern) if pattern else None
        self.pattern_fn = pattern_fn

    def check(self, errors: Errors, v: Any, path: str, allow_extra: bool = False) -> bool:
        """Error order: required, unknown keys (sorted), known props, pattern props."""
        if not isinstance(v, dict):
            _add_err(errors, path, "must be an object")
            return False
        for k in self.required:
            if k not in v:
                _add_err(errors, _ptr(path, k), "is required")
        keys = sorted(v.keys(), key=_sid)
        for k in keys:
            if k in self.props or (self.rx is not None and self.rx.fullmatch(_sid(k))):
                continue
            if not allow_extra:
                _add_err(errors, _ptr(path, k), "is not allowed")
        for k in self.order:
            if k in v:
                self.props[k](errors, v[k], _ptr(path, k))
        if self.rx is not None and self.pattern_fn is not None:
            for k in keys:
                if k not in self.props and self.rx.fullmatch(_sid(k)):
                    self.pattern_fn(errors, v[k], _ptr(path, k))
        return True

    def __call__(self, errors: Errors, v: Any, path: str) -> None:
        self.check(errors, v, path)


_v_generator = _ObjectSpec(
    ("app", "appVersion", "analyzerVersion", "modelSet"),
    {
        "app": _v_string(None, None),
        "appVersion": _v_string(None, None),
        "analyzerVersion": _v_string(None, None),
        "modelSet": _v_string(None, None),
    },
    ("app", "appVersion"),
)

_v_fingerprint = _ObjectSpec(
    ("size", "oshash", "headSha256", "sceneCuts"),
    {
        "size": _v_integer(0, None),
        "oshash": _v_string(None, P_OSHASH),
        "headSha256": _v_string(None, P_SHA256),
        "sceneCuts": _v_array(20000, _v_number(0, None)),
    },
    ("size", "oshash"),
)

_v_media = _ObjectSpec(
    ("title", "year", "duration", "filename", "offset", "fingerprint"),
    {
        "title": _v_string(500, None),
        "year": _v_integer(1880, 2200),
        "duration": _v_number(0, None),
        "filename": _v_string(1024, None),
        "offset": _v_number(None, None),
        "fingerprint": _v_fingerprint,
    },
    ("title", "duration", "fingerprint"),
)

_v_signals = _ObjectSpec(SIGNALS, {name: _v_number(0, 1) for name in SIGNALS})

_v_range_object = _ObjectSpec(
    ("id", "start", "end", "category", "confidence", "intensity", "action", "source", "review",
     "locked", "signals", "note", "cutStart", "cutEnd"),
    {
        "id": _v_string(None, P_RANGE_ID),
        "start": _v_number(0, None),
        "end": _v_number(0, None),
        "category": _v_enum(CATEGORIES),
        "confidence": _v_number(0, 1),
        "intensity": _v_integer(1, 3),
        "action": _v_enum(ACTIONS),
        "source": _v_enum(SOURCES),
        "review": _v_enum(REVIEWS),
        "locked": _v_boolean,
        "signals": _v_signals,
        "note": _v_string(300, None),
        "cutStart": _v_number(0, None),
        "cutEnd": _v_number(0, None),
    },
    ("id", "start", "end", "category", "confidence", "action", "source", "review"),
)


def _v_range(errors: Errors, v: Any, path: str) -> None:
    if not _v_range_object.check(errors, v, path):
        return
    if _is_number(v.get("start")) and _is_number(v.get("end")) and not (v["end"] > v["start"]):
        _add_err(errors, _ptr(path, "end"), "must be greater than start")


_v_stage = _ObjectSpec(
    ("status", "progress", "resumeAt", "detail", "model", "seconds"),
    {
        "status": _v_enum(STAGE_STATUS),
        "progress": _v_number(0, 1),
        "resumeAt": _v_number(0, None),
        "detail": _v_string(300, None),
        "model": _v_string(None, None),
        "seconds": _v_number(0, None),
    },
    ("status",),
)

_v_stages = _ObjectSpec(STAGE_NAMES, {name: _v_stage for name in STAGE_NAMES})

_v_levels = _ObjectSpec((), {}, (), P_LEVEL_KEY, _v_enum(LEVELS))

_v_scan = _ObjectSpec(
    ("status", "startedAt", "finishedAt", "stages", "levels", "device", "warnings"),
    {
        "status": _v_enum(SCAN_STATUS),
        "startedAt": _v_date_time,
        "finishedAt": _v_date_time,
        "stages": _v_stages,
        "levels": _v_levels,
        "device": _v_string(None, None),
        "warnings": _v_array(100, _v_string(500, None)),
    },
)

_v_summary_entry = _ObjectSpec(
    ("count", "seconds", "maxIntensity"),
    {
        "count": _v_integer(0, None),
        "seconds": _v_number(0, None),
        "maxIntensity": _v_integer(0, 3),
    },
)

_v_summary = _ObjectSpec((), {}, (), P_SUMMARY_KEY, _v_summary_entry)

_v_history_entry = _ObjectSpec(
    ("at", "event", "rangeId", "detail"),
    {
        "at": _v_date_time,
        "event": _v_enum(HISTORY_EVENTS),
        "rangeId": _v_string(None, P_RANGE_ID),
        "detail": _v_string(200, None),
    },
    ("at", "event"),
)


def _v_format(errors: Errors, v: Any, path: str) -> None:
    if not (isinstance(v, str) and v == FORMAT):
        _add_err(errors, path, 'must be "%s"' % FORMAT)


def _v_version(errors: Errors, v: Any, path: str) -> None:
    if not _is_integer(v):
        _add_err(errors, path, "must be an integer")
        return
    if v < VERSION:
        _add_err(errors, path, "must be >= %d" % VERSION)


_v_doc = _ObjectSpec(
    ("format", "version", "id", "created", "modified", "generator", "media", "language", "ranges",
     "scan", "summary", "history"),
    {
        "format": _v_format,
        "version": _v_version,
        "id": _v_string(None, P_UUID),
        "created": _v_date_time,
        "modified": _v_date_time,
        "generator": _v_generator,
        "media": _v_media,
        "language": _v_string(None, P_LANGUAGE),
        "ranges": _v_array(None, _v_range),
        "scan": _v_scan,
        "summary": _v_summary,
        "history": _v_array(MAX_HISTORY, _v_history_entry),
    },
    ("format", "version", "id", "created", "modified", "generator", "media", "ranges"),
)


def validate(doc: Any) -> dict[str, Any]:
    """Validate a parsed skip file. Paths are JSON Pointers ("" = the document).

    ``version`` is any integer >= 1 and unknown top-level keys are ignored
    (schema: top-level additionalProperties true, for forward
    compatibility); every known key is still checked against v1 and nested
    objects stay strict.

    Kid mode (player, M3/M5) additionally requires scan.status ==
    "complete"; a missing scan block counts as "none". validate() does not
    check that: a valid file may still be unplayable in kid mode.
    """
    errors: Errors = []
    _v_doc.check(errors, doc, "", True)
    return {"ok": not errors, "errors": errors}


# --------------------------------------------------------------------------
# ranges: ordering, enforcement, intervals
# --------------------------------------------------------------------------


def is_enforced(r: Any) -> bool:
    return isinstance(r, dict) and r.get("review") != "rejected" and r.get("action") != "none"


def _is_visual(r: Range) -> bool:
    return r.get("action") in VISUAL_ACTIONS


def _time_key(r: Range) -> tuple[Any, ...]:
    return (r["start"], r["end"], _sid(r.get("id")))


def _precedence_key(r: Range) -> tuple[Any, ...]:
    """Highest first: visual action, locked, confidence, approved, intensity, then time, id."""
    return (
        0 if _is_visual(r) else 1,
        0 if r.get("locked") is True else 1,
        -_num(r.get("confidence")),
        0 if r.get("review") == "approved" else 1,
        -_num(r.get("intensity")),
        r["start"],
        r["end"],
        _sid(r.get("id")),
    )


def _union(intervals: Iterable[Interval]) -> list[Interval]:
    """Union of [start, end) intervals; touching intervals are joined."""
    out: list[Interval] = []
    for s, e in sorted((iv[0], iv[1]) for iv in intervals):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return out


def _subtract(start: float, end: float, u: list[Interval]) -> list[Interval]:
    """[start, end) minus a sorted union -> pieces."""
    pieces: list[Interval] = []
    cur = start
    for a, b in u:
        if b <= cur or a >= end:
            continue
        if a > cur:
            pieces.append([cur, a])
        if b > cur:
            cur = b
    if cur < end:
        pieces.append([cur, end])
    return pieces


def _overlap_length(start: float, end: float, u: list[Interval]) -> float:
    total: float = 0
    for a, b in u:
        lo = a if a > start else start
        hi = b if b < end else end
        if hi > lo:
            total += hi - lo
    return total


def _contained_in(start: float, end: float, u: list[Interval]) -> bool:
    return any(a <= start and end <= b for a, b in u)


# --------------------------------------------------------------------------
# summary / history
# --------------------------------------------------------------------------


def summarise(doc: Any) -> dict[str, dict[str, float]]:
    """Per-category counts of ENFORCED ranges only: review pending or approved
    AND action != none (schema: summary)."""
    s: dict[str, dict[str, Any]] = {c: {"count": 0, "seconds": 0, "maxIntensity": 0} for c in CATEGORIES}
    ranges = doc.get("ranges") if isinstance(doc, dict) and isinstance(doc.get("ranges"), list) else []
    for r in ranges:
        if not isinstance(r, dict) or not isinstance(r.get("category"), str) or r["category"] not in s:
            continue
        if r.get("review") not in ("pending", "approved") or r.get("action") == "none":
            continue
        if not _is_number(r.get("start")) or not _is_number(r.get("end")):
            continue
        e = s[r["category"]]
        e["count"] += 1
        e["seconds"] += r["end"] - r["start"]
        if _is_integer(r.get("intensity")) and r["intensity"] > e["maxIntensity"]:
            e["maxIntensity"] = r["intensity"]
    for c in CATEGORIES:
        s[c]["seconds"] = _round3(s[c]["seconds"])
    return s


def add_history(doc: Doc, event: str, range_id: Any = None, detail: Any = None,
                now: str | None = None) -> Doc:
    """Append a history entry in place and return doc; keeps the newest 2000.

    Detail is cut to 200 code points. Raises TypeError on unknown events.
    """
    if event not in HISTORY_EVENTS:
        raise TypeError("unknown history event: %s" % event)
    if not isinstance(doc.get("history"), list):
        doc["history"] = []
    e: dict[str, Any] = {"at": _now_iso(now), "event": event}
    if range_id is not None and range_id != "":
        e["rangeId"] = _sid(range_id)
    if detail is not None and detail != "":
        e["detail"] = _sid(detail)[:200]
    doc["history"].append(e)
    if len(doc["history"]) > MAX_HISTORY:
        del doc["history"][: len(doc["history"]) - MAX_HISTORY]
    return doc


# --------------------------------------------------------------------------
# normalise
# --------------------------------------------------------------------------


def _merge_cluster(members: list[Range]) -> Range:
    keeper = sorted(members, key=_precedence_key)[0]
    out = copy.deepcopy(keeper)
    out["start"] = members[0]["start"]
    out["end"] = members[0]["end"]
    out["confidence"] = _num(members[0].get("confidence"))
    out["action"] = members[0].get("action")
    end_member = members[0]
    all_approved = True
    has_intensity = False
    max_intensity: Any = 0
    sig: dict[str, Any] | None = None
    for m in members:
        if m["start"] < out["start"]:
            out["start"] = m["start"]
        if m["end"] > out["end"]:
            out["end"] = m["end"]
            end_member = m
        if _num(m.get("confidence")) > out["confidence"]:
            out["confidence"] = m["confidence"]
        a, b = ACTION_STRENGTH.get(m.get("action")), ACTION_STRENGTH.get(out["action"])  # type: ignore[arg-type]
        if a is not None and b is not None and a > b:
            out["action"] = m["action"]
        if m.get("review") != "approved":
            all_approved = False
        if _is_integer(m.get("intensity")) and (not has_intensity or m["intensity"] > max_intensity):
            has_intensity = True
            max_intensity = m["intensity"]
        if isinstance(m.get("signals"), dict):
            if sig is None:
                sig = {}
            for k in SIGNALS:
                best = m["signals"].get(k)
                if _is_number(best) and (k not in sig or best > sig[k]):
                    sig[k] = best
    out["review"] = "approved" if all_approved else "pending"
    if has_intensity:
        out["intensity"] = max_intensity
    else:
        out.pop("intensity", None)
    if sig is not None:
        out["signals"] = {k: sig[k] for k in SIGNALS if k in sig}
    else:
        out.pop("signals", None)
    if "cutStart" in members[0]:
        out["cutStart"] = members[0]["cutStart"]
    else:
        out.pop("cutStart", None)
    if "cutEnd" in end_member:
        out["cutEnd"] = end_member["cutEnd"]
    else:
        out.pop("cutEnd", None)
    return out


def _merge_same_category(items: list[Range]) -> list[Range]:
    """Phase A: merge overlapping enforced, unlocked ranges of the same category."""
    out = [r for r in items if r.get("locked") is True]
    for cat in CATEGORIES:
        group = [r for r in items if r.get("locked") is not True and r.get("category") == cat]
        cluster: list[Range] = []
        cluster_end: Any = 0
        for r in group + [None]:  # type: ignore[list-item]
            if r is not None and cluster and r["start"] < cluster_end:
                cluster.append(r)
                if r["end"] > cluster_end:
                    cluster_end = r["end"]
                continue
            if len(cluster) == 1:
                out.append(cluster[0])
            elif len(cluster) > 1:
                out.append(_merge_cluster(cluster))
            if r is not None:
                cluster = [r]
                cluster_end = r["end"]
    out.extend(r for r in items if r.get("locked") is not True and r.get("category") not in CATEGORIES)
    return out


def _resolve_overlaps(items: list[Range], used: set[str]) -> list[Range]:
    """Phase B: higher precedence wins; lower ones are trimmed (split if needed).

    Locked ranges are never trimmed.
    """
    out: list[Range] = []
    taken: list[Interval] = []
    for r in sorted(items, key=_precedence_key):
        if r.get("locked") is True:
            out.append(r)
            taken.append([r["start"], r["end"]])
            continue
        for p, (s, e) in enumerate(_subtract(r["start"], r["end"], _union(taken))):
            piece = copy.deepcopy(r)
            if p > 0:
                piece["id"] = _derive_id(r.get("id"), used)
                used.add(piece["id"])
            piece["start"] = s
            piece["end"] = e
            if s != r["start"]:
                piece.pop("cutStart", None)
            if e != r["end"]:
                piece.pop("cutEnd", None)
            out.append(piece)
            taken.append([s, e])
    return out


def normalise(doc: Any, now: str | None = None) -> Any:
    """Deep copy; clamp ranges to [0, duration] (no upper clamp when duration
    is 0 = unknown); drop empty ranges; make ids unique; among ENFORCED
    ranges merge same-category overlaps and resolve the rest by precedence;
    sort by start; regenerate summary; set modified."""
    out = copy.deepcopy(doc)
    if not isinstance(out, dict):
        return out
    media = out.get("media") if isinstance(out.get("media"), dict) else {}
    duration = _num(media.get("duration"))
    src = out.get("ranges") if isinstance(out.get("ranges"), list) else []
    ranges: list[Range] = []
    used: set[str] = set()
    for r in src:
        if not isinstance(r, dict) or not _is_number(r.get("start")) or not _is_number(r.get("end")):
            continue
        if r["start"] < 0:
            r["start"] = 0
        if duration > 0 and r["end"] > duration:
            r["end"] = duration
        if not (r["end"] > r["start"]):
            continue
        ranges.append(r)
        used.add(_sid(r.get("id")))
    ranges.sort(key=_time_key)
    seen: set[str] = set()
    enforced_list: list[Range] = []
    rest: list[Range] = []
    for r in ranges:
        if _sid(r.get("id")) in seen:
            r["id"] = _derive_id(r.get("id"), used)
            used.add(r["id"])
        seen.add(_sid(r.get("id")))
        (enforced_list if is_enforced(r) else rest).append(r)
    enforced_list = _resolve_overlaps(_merge_same_category(enforced_list), used)
    out["ranges"] = sorted(rest + enforced_list, key=_time_key)
    out["summary"] = summarise(out)
    out["modified"] = _now_iso(now)
    return out


# --------------------------------------------------------------------------
# enforcement and exports
# --------------------------------------------------------------------------


def enforced(doc: Any) -> list[Range]:
    """Ranges the player obeys: review != rejected and action != none, with
    media.offset added, start clamped at 0, empty ones dropped, sorted.
    Returns copies."""
    if not isinstance(doc, dict) or not isinstance(doc.get("ranges"), list):
        return []
    offset = _num(doc["media"].get("offset")) if isinstance(doc.get("media"), dict) else 0
    out: list[Range] = []
    for r in doc["ranges"]:
        if not is_enforced(r) or not _is_number(r.get("start")) or not _is_number(r.get("end")):
            continue
        c = copy.deepcopy(r)
        c["start"] = r["start"] + offset
        c["end"] = r["end"] + offset
        if c["start"] < 0:
            c["start"] = 0
        if not (c["end"] > c["start"]):
            continue
        out.append(c)
    return sorted(out, key=_time_key)


def to_kodi_edl(doc: Any) -> str:
    """One "start end action" line per enforced stretch: 0 (cut) for
    skip/hide/blur, 1 (mute) for mute. Times include media.offset, 2
    decimals, rounded outward. Overlapping or touching cuts are joined; mute
    is dropped where a cut already covers it."""
    cuts: list[Interval] = []
    mutes: list[Interval] = []
    for r in enforced(doc):
        s, e = _floor_cs(r["start"]), _ceil_cs(r["end"])
        if not e > s:
            continue
        (mutes if r.get("action") == "mute" else cuts).append([s, e])
    cuts = _union(cuts)
    lines: list[tuple[int, int, int]] = [(int(a), int(b), 0) for a, b in cuts]
    for a, b in _union(mutes):
        lines.extend((int(x), int(y), 1) for x, y in _subtract(a, b, cuts))
    lines.sort()
    return "".join("%s %s %d\n" % (_fmt_cs(a), _fmt_cs(b), t) for a, b, t in lines)


def _edl_path(p: str) -> str:
    """mpv EDL file field: "%<utf-8 bytes>%path" when the path needs quoting."""
    if re.search(r"[,;%=\r\n]", p) or re.match(r"[#! \t]", p) or re.search(r"[ \t]\Z", p):
        return "%%%d%%%s" % (_utf8_length(p), p)
    return p


def to_mpv_edl(doc: Any, media_path: Any) -> str:
    """"# mpv EDL v0" then one "path,start,length" line per KEPT segment.
    Every enforced range is removed (an mpv EDL cannot mute or hide, so mute
    ranges are cut too: fail closed). The last segment has no length, so it
    plays to the end of the file whatever the edition's real duration."""
    p = _edl_path("" if media_path is None else _sid(media_path))
    cuts: list[Interval] = []
    for r in enforced(doc):
        s, e = _floor_cs(r["start"]), _ceil_cs(r["end"])
        if e > s:
            cuts.append([s, e])
    cuts = _union(cuts)
    media = doc.get("media") if isinstance(doc, dict) and isinstance(doc.get("media"), dict) else {}
    end_cs = _floor_cs(_num(media.get("duration")) + _num(media.get("offset"))) if _num(media.get("duration")) > 0 else None
    out = "# mpv EDL v0\n"
    cur = 0
    for a, b in cuts:
        if end_cs is not None and a >= end_cs:
            break
        if a > cur:
            out += "%s,%s,%s\n" % (p, _fmt_cs(int(cur)), _fmt_cs(int(a - cur)))
        if b > cur:
            cur = b
    if end_cs is None or cur < end_cs:
        out += "%s,%s\n" % (p, _fmt_cs(int(cur)))
    return out


# --------------------------------------------------------------------------
# offset, merge
# --------------------------------------------------------------------------


def apply_offset(doc: Doc, seconds: float, now: str | None = None) -> Doc:
    """New doc with media.offset SET to ``seconds`` (absolute, not added), an
    offsetChanged history entry and a new modified time. Ranges untouched."""
    if not _is_number(seconds):
        raise TypeError("offset must be a finite number")
    stamp = _now_iso(now)
    out = copy.deepcopy(doc)
    if not isinstance(out.get("media"), dict):
        out["media"] = {}
    prev = _num(out["media"].get("offset"))
    out["media"]["offset"] = seconds
    add_history(out, "offsetChanged", None, "offset %s -> %s" % (_fmt_seconds(prev), _fmt_seconds(seconds)), stamp)
    out["modified"] = stamp
    return out


def _is_replaceable(r: Range) -> bool:
    """Old ranges a rescan replaces: automatic, still pending, not edited."""
    return r.get("source") == "auto" and r.get("review") == "pending" and r.get("locked") is not True


def merge(old_doc: Any, new_scan_doc: Any, now: str | None = None) -> Doc:
    """Merge a fresh scan into an existing skip file (same rules as skipfile.js).

    Keeps every old range that is locked, approved, rejected, or manual /
    panic / imported. Old auto+pending ranges are replaced by the new scan's
    ranges, except that a new auto range is dropped when more than 50% of
    its length overlaps old dismissed ranges (rejected, or action none) of
    the SAME category, or when it lies entirely inside old enforced kept
    ranges of the same category. Colliding new ids are re-derived.
    """
    stamp = _now_iso(now)
    o: dict[str, Any] = copy.deepcopy(old_doc) if isinstance(old_doc, dict) else {}
    n: dict[str, Any] = copy.deepcopy(new_scan_doc) if isinstance(new_scan_doc, dict) else {}

    def pick(key: str, fallback: Any) -> Any:
        if _truthy(o.get(key)):
            return o[key]
        if _truthy(n.get(key)):
            return n[key]
        return fallback

    out: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "id": pick("id", None) or uuid4(),
        "created": pick("created", stamp),
        "modified": stamp,
        "generator": n["generator"] if _truthy(n.get("generator")) else (
            o["generator"] if _truthy(o.get("generator")) else {"app": APP_NAME, "appVersion": LIB_VERSION}),
        "media": n["media"] if isinstance(n.get("media"), dict) else (
            o["media"] if isinstance(o.get("media"), dict) else {}),
    }
    if isinstance(o.get("media"), dict) and isinstance(n.get("media"), dict):
        for k in ("title", "year", "offset"):
            if k in o["media"]:
                out["media"][k] = o["media"][k]
    if "language" in n:
        out["language"] = n["language"]
    elif "language" in o:
        out["language"] = o["language"]
    out["ranges"] = []
    if "scan" in n:
        out["scan"] = n["scan"]
    elif "scan" in o:
        out["scan"] = o["scan"]
    out["history"] = o["history"] if isinstance(o.get("history"), list) else []

    dismissed: dict[str, list[Interval]] = {c: [] for c in CATEGORIES}
    covered: dict[str, list[Interval]] = {c: [] for c in CATEGORIES}
    kept: list[Range] = []
    used: set[str] = set()
    replaced = 0
    for r in o.get("ranges") if isinstance(o.get("ranges"), list) else []:
        if not isinstance(r, dict):
            continue
        if _is_replaceable(r):
            replaced += 1
            continue
        kept.append(r)
        used.add(_sid(r.get("id")))
        cat = r.get("category")
        if isinstance(cat, str) and cat in dismissed and _is_number(r.get("start")) and _is_number(r.get("end")):
            (covered if is_enforced(r) else dismissed)[cat].append([r["start"], r["end"]])
    dismissed = {c: _union(v) for c, v in dismissed.items()}
    covered = {c: _union(v) for c, v in covered.items()}

    src_new = n.get("ranges") if isinstance(n.get("ranges"), list) else []
    new_ranges = sorted(
        (r for r in src_new if isinstance(r, dict) and _is_number(r.get("start")) and _is_number(r.get("end"))),
        key=_time_key,
    )
    added: list[Range] = []
    dropped = 0
    for r in new_ranges:
        cat = r.get("category")
        if r.get("source") == "auto" and isinstance(cat, str) and cat in dismissed:
            length = r["end"] - r["start"]
            if (_overlap_length(r["start"], r["end"], dismissed[cat]) > 0.5 * length
                    or _contained_in(r["start"], r["end"], covered[cat])):
                dropped += 1
                continue
        if _sid(r.get("id")) in used:
            r["id"] = _derive_id(r.get("id"), used)
        used.add(_sid(r.get("id")))
        added.append(r)
    out["ranges"] = kept + added
    add_history(out, "scanned", None, "kept %d, replaced %d, added %d, dropped %d"
                % (len(kept), replaced, len(added), dropped), stamp)
    return normalise(out, stamp)


# --------------------------------------------------------------------------
# constructors and parsing
# --------------------------------------------------------------------------


def new_doc(fields: dict[str, Any] | None = None, now: str | None = None) -> Doc:
    """A valid empty skip file; fills format, version, id, created, modified,
    generator, placeholder media, empty ranges and a "created" history entry
    unless ``fields`` supplies them."""
    f = copy.deepcopy(fields) if isinstance(fields, dict) else {}
    stamp = _now_iso(now)
    created = f["created"] if isinstance(f.get("created"), str) else stamp
    doc: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "id": f["id"] if isinstance(f.get("id"), str) else uuid4(),
        "created": created,
        "modified": f["modified"] if isinstance(f.get("modified"), str) else created,
        "generator": f["generator"] if isinstance(f.get("generator"), dict)
        else {"app": APP_NAME, "appVersion": LIB_VERSION},
        "media": f["media"] if isinstance(f.get("media"), dict)
        else {"title": "", "duration": 0, "fingerprint": {"size": 0, "oshash": "0000000000000000"}},
        "ranges": f["ranges"] if isinstance(f.get("ranges"), list) else [],
    }
    for k in ("language", "scan", "summary", "history"):
        if k in f:
            doc[k] = f[k]
    if not isinstance(doc.get("history"), list):
        doc["history"] = [{"at": doc["created"], "event": "created"}]
    return doc


def new_range(fields: dict[str, Any] | None = None) -> Range:
    """A range with defaults (manual "other" skip mark, pending, confidence 1).
    Only schema keys are copied. id = "r" + 8 base36 characters unless given."""
    f = fields if isinstance(fields, dict) else {}
    r: dict[str, Any] = {
        "id": f["id"] if isinstance(f.get("id"), str) else _range_id(),
        "start": f.get("start", 0),
        "end": f.get("end", 0),
        "category": f.get("category", "other"),
        "confidence": f.get("confidence", 1),
        "action": f.get("action", "skip"),
        "source": f.get("source", "manual"),
        "review": f.get("review", "pending"),
    }
    for k in ("intensity", "locked", "signals", "note", "cutStart", "cutEnd"):
        if k in f:
            r[k] = copy.deepcopy(f[k])
    return r


def _reject_constant(name: str) -> Any:
    raise ValueError("non-standard JSON constant " + name)


def _js_numbers(v: Any) -> Any:
    """Integral floats become ints, as JavaScript prints them ("214", not "214.0")."""
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return int(v)
    if isinstance(v, dict):
        return {k: _js_numbers(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_js_numbers(x) for x in v]
    return v


def to_json(doc: Any) -> str:
    """Serialise like ``JSON.stringify(doc, null, 2) + "\\n"`` in skipfile.js.

    Byte-identical to the JavaScript output for every fixture; floats outside
    JavaScript's plain-decimal range (|x| < 1e-6 or >= 1e21) are spelled
    differently by the two languages (same value)."""
    return json.dumps(_js_numbers(doc), indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def _fail(msg: str) -> dict[str, Any]:
    return {"ok": False, "doc": None, "errors": [{"path": "", "msg": msg}]}


def from_json(text: Any) -> dict[str, Any]:
    """Parse and validate. Never raises. ``doc`` is None unless the text
    parsed AND validated. Accepts str, or bytes as UTF-8. A leading BOM is
    ignored. NaN/Infinity literals are refused, as JSON.parse does."""
    try:
        if isinstance(text, (bytes, bytearray)):
            try:
                text = bytes(text).decode("utf-8")
            except UnicodeDecodeError:
                return _fail("not valid JSON")
        if not isinstance(text, str):
            return _fail("input must be a string")
        if text.startswith("﻿"):
            text = text[1:]
        try:
            doc = json.loads(text, parse_constant=_reject_constant)
        except (ValueError, RecursionError, TypeError):
            return _fail("not valid JSON")
        res = validate(doc)
        return {"ok": res["ok"], "doc": doc if res["ok"] else None, "errors": res["errors"]}
    except Exception as e:  # noqa: BLE001 - must never raise
        return _fail("unreadable: %s" % (e,))


__all__ = [
    "FORMAT", "VERSION", "CATEGORIES", "ACTIONS", "SOURCES", "REVIEWS", "LEVELS", "HISTORY_EVENTS",
    "MAX_HISTORY", "validate", "normalise", "enforced", "is_enforced", "summarise", "merge",
    "apply_offset", "to_kodi_edl", "to_mpv_edl", "new_doc", "new_range", "from_json", "to_json", "add_history",
    "uuid4",
]
