"""ffprobe -> duration, streams, subtitle tracks, keyframe interval."""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Dict, List, Optional

from ..protocol import BadInput
from .tools import popen_kwargs, tool

TEXT_SUB_CODECS = ("subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text", "microdvd", "subviewer",
                   "subviewer1", "sami", "realtext", "jacosub", "mpl2", "pjs", "vplayer", "stl", "eia_608")


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _rate(v: Any) -> Optional[float]:
    if not isinstance(v, str) or "/" not in v:
        return _num(v)
    a, b = v.split("/", 1)
    na, nb = _num(a), _num(b)
    if not na or not nb:
        return None
    return na / nb


def _rotation(st: Dict[str, Any]) -> int:
    rot = 0
    tags = st.get("tags") or {}
    if "rotate" in tags:
        rot = int(_num(tags["rotate"]) or 0)
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(_num(sd["rotation"]) or 0)
    return rot % 360


def ffprobe_json(path: str, extra: Optional[List[str]] = None, timeout: float = 60) -> Dict[str, Any]:
    cmd = [tool("ffprobe"), "-v", "error", "-print_format", "json"] + (extra or ["-show_format", "-show_streams"]) + [path]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                             stdin=subprocess.DEVNULL, **popen_kwargs())
    except subprocess.TimeoutExpired as e:
        raise BadInput("ffprobe timed out on the file") from e
    if res.returncode != 0:
        raise BadInput("not a readable video file: %s" % res.stderr.decode("utf-8", "replace").strip()[-300:])
    try:
        return json.loads(res.stdout.decode("utf-8", "replace") or "{}")
    except ValueError as e:
        raise BadInput("ffprobe returned unreadable output") from e


def probe(path: str) -> Dict[str, Any]:
    """Describe a media file. Raises BadInput for missing/unreadable files or no video."""
    if not os.path.isfile(path):
        raise BadInput("input file not found: %s" % path)
    data = ffprobe_json(path)
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    video = None
    audio: List[Dict[str, Any]] = []
    subs: List[Dict[str, Any]] = []
    for st in streams:
        kind = st.get("codec_type")
        disp = st.get("disposition") or {}
        tags = st.get("tags") or {}
        if kind == "video" and video is None and not disp.get("attached_pic"):
            w, h = int(st.get("width") or 0), int(st.get("height") or 0)
            rot = _rotation(st)
            if rot in (90, 270):
                w, h = h, w
            video = {
                "index": st.get("index"), "codec": st.get("codec_name"), "width": w, "height": h,
                "rotation": rot, "fps": _rate(st.get("avg_frame_rate")) or _rate(st.get("r_frame_rate")),
                "duration": _num(st.get("duration")),
            }
        elif kind == "audio":
            audio.append({"index": st.get("index"), "codec": st.get("codec_name"),
                          "language": (tags.get("language") or "").lower(), "channels": st.get("channels")})
        elif kind == "subtitle":
            title = tags.get("title") or ""
            subs.append({
                "index": st.get("index"), "subIndex": len(subs), "codec": st.get("codec_name") or "",
                "language": (tags.get("language") or "").lower(), "title": title,
                "forced": bool(disp.get("forced")) or "forced" in title.lower(),
                "hearingImpaired": bool(disp.get("hearing_impaired")) or any(
                    k in title.lower() for k in ("sdh", "cc", "hearing")),
                "textBased": (st.get("codec_name") or "") in TEXT_SUB_CODECS,
            })
    if video is None or not video["width"]:
        raise BadInput("the file has no video stream")
    duration = _num(fmt.get("duration")) or video.get("duration") or 0.0
    return {
        "path": os.path.abspath(path),
        "size": int(_num(fmt.get("size")) or os.path.getsize(path)),
        "duration": float(duration),
        "formatName": fmt.get("format_name"),
        "title": (fmt.get("tags") or {}).get("title") or "",
        "video": video,
        "audio": audio,
        "subtitles": subs,
    }


def keyframe_interval(path: str, seconds: float = 60.0) -> Optional[float]:
    """Mean keyframe spacing over the first ``seconds`` (cheap: keyframes only)."""
    try:
        data = ffprobe_json(path, ["-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries",
                                   "frame=pts_time,best_effort_timestamp_time", "-read_intervals",
                                   "%%+%d" % int(seconds)], timeout=60)
    except BadInput:
        return None
    ts = []
    for fr in data.get("frames") or []:
        t = _num(fr.get("pts_time")) if fr.get("pts_time") is not None else _num(fr.get("best_effort_timestamp_time"))
        if t is not None:
            ts.append(t)
    ts.sort()
    if len(ts) < 2:
        return None
    return round((ts[-1] - ts[0]) / (len(ts) - 1), 3)
