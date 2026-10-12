"""Build, validate, merge and atomically write the skip file."""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional, Sequence

from . import __version__, config
from . import skipfile as sf

log = logging.getLogger("bonis.output")

STAGE_KEYS = ("status", "progress", "resumeAt", "detail", "model", "seconds")


def _stage(obj: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: obj[k] for k in STAGE_KEYS if k in obj and obj[k] is not None}
    if "progress" in out:
        out["progress"] = max(0.0, min(1.0, round(float(out["progress"]), 4)))
    if "seconds" in out:
        out["seconds"] = round(max(0.0, float(out["seconds"])), 1)
    if "detail" in out:
        out["detail"] = str(out["detail"])[:300]
    return out


def build_doc(media: Dict[str, Any], fp: Dict[str, Any], cuts: Sequence[float], ranges: Sequence[Dict[str, Any]],
              lang: str, levels: Dict[str, str], stages: Dict[str, Dict[str, Any]], status: str,
              warnings: Sequence[str], started: str, finished: str, device: str,
              now: Optional[str] = None) -> Dict[str, Any]:
    path = media["path"]
    base = os.path.basename(path)
    title = (media.get("title") or os.path.splitext(base)[0])[:500]
    fingerprint: Dict[str, Any] = {"size": int(fp["size"]), "oshash": fp["oshash"]}
    if fp.get("headSha256"):
        fingerprint["headSha256"] = fp["headSha256"]
    sc = sorted({round(float(c), 3) for c in cuts if c >= 0})[:20000]
    if sc:
        fingerprint["sceneCuts"] = sc
    doc = sf.new_doc({
        "generator": {"app": sf.APP_NAME, "appVersion": __version__, "analyzerVersion": __version__,
                      "modelSet": config.MODEL_SET},
        "media": {"title": title, "duration": round(float(media.get("duration") or 0.0), 3),
                  "filename": base[:1024], "fingerprint": fingerprint},
        "language": lang if lang in ("es-MX", "en-US") else ("es-MX" if lang.lower().startswith("es") else "en-US"),
        "ranges": [sf.new_range(r) for r in ranges],
        "scan": {
            "status": status, "startedAt": started, "finishedAt": finished,
            "stages": {k: _stage(v) for k, v in stages.items() if k in sf.STAGE_NAMES},
            "levels": {c: levels[c] for c in config.CATEGORIES if c in levels},
            "device": device,
            "warnings": [str(w)[:500] for w in warnings][:100],
        },
    }, now)
    sf.add_history(doc, "scanned", None, "%d ranges" % len(ranges), now)
    return sf.normalise(doc, now)


def read_existing(path: str) -> Optional[Dict[str, Any]]:
    """Existing valid skip file, or None. A corrupt file is moved aside
    (<out>.corrupt-<epoch>) so nothing a parent wrote is silently lost."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            res = sf.from_json(f.read())
    except OSError:
        return None
    if res["ok"]:
        return res["doc"]
    aside = "%s.corrupt-%d" % (path, int(time.time()))
    try:
        os.replace(path, aside)
        log.warning("existing skip file was unreadable; moved aside")
    except OSError:
        pass
    return None


def write_atomic(path: str, text: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, ".%s.%d.tmp" % (os.path.basename(path), os.getpid()))
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def write_skipfile(path: str, doc: Dict[str, Any], now: Optional[str] = None) -> Dict[str, Any]:
    """Merge with an existing file (locked / reviewed ranges survive), validate, write."""
    old = read_existing(path)
    final = sf.merge(old, doc, now) if old is not None else doc
    res = sf.validate(final)
    if not res["ok"]:
        raise ValueError("internal: generated skip file is invalid: %s" % res["errors"][:3])
    write_atomic(path, sf.to_json(final))
    return final


def thumb_ranges(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [r for r in doc.get("ranges", []) if r.get("review") != "rejected"]
