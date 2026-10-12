"""Third ffmpeg pass: one keyframe per selected shot for the caption model.

Per shot: ``ffmpeg -ss T -i F -map 0:v:0 -frames:v 1 -vf scale=768:768:flags=bicubic
-f rawvideo -pix_fmt rgb24 pipe:1`` (input seeking: demux jumps to the keyframe
before T and decodes only up to T). Chosen over a single pass with a
``select`` filter on the timestamps because its cost scales with the number of
shots captioned (budgeted, <= 1500), not with the film's length, and each shot
is independently resumable (measured in analyzer/BENCH.md). The frame goes
straight into memory: no image file is ever written.
"""

from __future__ import annotations

import subprocess
from typing import List, Optional

import numpy as np

from .. import config
from .tools import popen_kwargs, tool


def keyframe_command(path: str, t: float, size: int = config.CAPTION_SIZE, threads: int = 0) -> List[str]:
    cmd = [tool("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error"]
    if threads:
        cmd += ["-threads", str(int(threads))]
    cmd += ["-ss", "%.3f" % max(0.0, t), "-i", path, "-map", "0:v:0", "-frames:v", "1",
            "-vf", "scale=%d:%d:flags=bicubic" % (size, size), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    return cmd


def grab(path: str, t: float, size: int = config.CAPTION_SIZE, threads: int = 0,
         timeout: float = 120) -> Optional[np.ndarray]:
    """size x size x 3 uint8 RGB frame at ``t`` (None when nothing decodes there)."""
    res = subprocess.run(keyframe_command(path, t, size, threads), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, timeout=timeout, **popen_kwargs())
    need = size * size * 3
    if len(res.stdout) < need:
        return None
    return np.frombuffer(res.stdout[:need], dtype=np.uint8).reshape(size, size, 3)
