"""Blurred review thumbnails: one frame per range at its midpoint, scaled to
160 px and box-blurred INSIDE ffmpeg, so no clear frame is ever written."""

from __future__ import annotations

import logging
import os
import subprocess
from typing import Any, Dict, List, Sequence

from .. import config
from .tools import popen_kwargs, tool

log = logging.getLogger("bonis.thumbs")


def thumb_command(media: str, t: float, out: str) -> List[str]:
    return [tool("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error", "-y",
            "-ss", "%.3f" % max(0.0, t), "-i", media, "-frames:v", "1",
            "-vf", "scale=%d:-2,%s" % (config.THUMB_WIDTH, config.THUMB_BLUR),
            "-q:v", "5", "-update", "1", "-f", "image2", out]


def make_thumbs(media: str, work: str, ranges: Sequence[Dict[str, Any]], duration: float,
                limit: int = config.MAX_THUMBS) -> List[str]:
    """Write <work>/thumbs/<rangeId>.jpg for each range (existing ones kept)."""
    d = os.path.join(work, "thumbs")
    os.makedirs(d, exist_ok=True)
    made = []
    for r in list(ranges)[:limit]:
        out = os.path.join(d, r["id"] + ".jpg")
        if os.path.isfile(out):
            continue
        mid = (float(r["start"]) + float(r["end"])) / 2.0
        if duration > 0:
            mid = min(mid, max(0.0, duration - 0.5))
        try:
            res = subprocess.run(thumb_command(media, mid, out), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                 stdin=subprocess.DEVNULL, timeout=120, **popen_kwargs())
            if res.returncode == 0 and os.path.isfile(out):
                made.append(out)
            else:
                log.warning("thumbnail failed for a range (rc=%s)", res.returncode)
                if os.path.exists(out):
                    os.remove(out)
        except (OSError, subprocess.TimeoutExpired):
            log.warning("thumbnail failed for a range")
            if os.path.exists(out):
                os.remove(out)
    return made
