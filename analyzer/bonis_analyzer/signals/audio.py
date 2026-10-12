"""Audio-event signal: YAMNet (AudioSet, 521 classes) over the 16 kHz mono
stream, 10 s chunks with 1 s of the previous chunk prepended so no 0.96 s
frame is lost at a seam. Class scores -> categories through
config.AUDIO_CLASS_MAP (weights); per second = max over overlapping frames.

Scorers return the raw [frames, 521] class-score matrix for one chunk; the
mapping to categories is shared by the real model and the test hook.
"""

from __future__ import annotations

import csv
import gc
import math
import os
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .. import config
from ..protocol import ModelMissing

AUDIO_CATEGORIES = tuple(sorted({c for m in config.AUDIO_CLASS_MAP.values() for c in m},
                                key=config.CATEGORIES.index))
_HERE_MODELS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "models")


def class_map_path(models_dir: Optional[str] = None) -> str:
    for d in ([models_dir] if models_dir else []) + [_HERE_MODELS]:
        p = os.path.join(d, config.YAMNET_CLASS_MAP_FILE)
        if os.path.isfile(p):
            return p
    raise ModelMissing("sound class list (%s) not found" % config.YAMNET_CLASS_MAP_FILE)


def load_class_names(path: str) -> List[str]:
    """index,mid,display_name CSV -> display names in model output order."""
    names: Dict[int, str] = {}
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            names[int(row["index"])] = row["display_name"]
    if sorted(names) != list(range(len(names))) or len(names) != config.YAMNET_CLASSES:
        raise ModelMissing("sound class list is damaged; reinstall bonis oculis")
    return [names[i] for i in range(len(names))]


def category_columns(names: Sequence[str],
                     class_map: Optional[Dict[str, Dict[str, float]]] = None) -> Dict[str, Tuple[np.ndarray, np.ndarray]]:
    """category -> (class column indices, weights)."""
    class_map = config.AUDIO_CLASS_MAP if class_map is None else class_map
    index = {n: i for i, n in enumerate(names)}
    cols: Dict[str, Tuple[List[int], List[float]]] = {}
    for cls, per in class_map.items():
        if cls not in index:
            raise ValueError("AUDIO_CLASS_MAP: unknown AudioSet class %r" % cls)
        for cat, w in per.items():
            cols.setdefault(cat, ([], []))
            cols[cat][0].append(index[cls])
            cols[cat][1].append(float(w))
    return {c: (np.asarray(i, dtype=np.int64), np.asarray(w, dtype=np.float32)) for c, (i, w) in cols.items()}


def frame_categories(scores: np.ndarray, cols: Dict[str, Tuple[np.ndarray, np.ndarray]]) -> Dict[str, np.ndarray]:
    """[F, 521] class scores -> {category: [F]} = max_k w_k * score_k."""
    s = np.clip(np.nan_to_num(np.asarray(scores, dtype=np.float32), nan=0.0), 0.0, 1.0)
    if s.ndim == 1:
        s = s[None, :]
    return {c: (s[:, idx] * w[None, :]).max(axis=1) if s.shape[0] else np.zeros(0, np.float32)
            for c, (idx, w) in cols.items()}


def accumulate(arrays: Dict[str, np.ndarray], per_frame: Dict[str, np.ndarray], t0: float,
               hop: float = config.YAMNET_HOP, window: float = config.YAMNET_WINDOW,
               limit: Optional[float] = None) -> None:
    """Max each frame's category score into every second its window overlaps.
    Frames starting at or after ``limit`` (end of real audio) are ignored."""
    for c, v in per_frame.items():
        if c not in arrays:
            continue
        a = arrays[c]
        n = len(a)
        for k, val in enumerate(v):
            if val <= 0:
                continue
            fs = t0 + k * hop
            if limit is not None and fs >= limit:
                break
            lo = max(0, int(math.floor(fs + 1e-6)))
            hi = min(n, int(math.ceil(fs + window - 1e-6)))
            if hi > lo:
                seg = a[lo:hi]
                np.maximum(seg, float(val), out=seg)


def frame_count(samples: int, rate: int = config.AUDIO_RATE) -> int:
    """YAMNet's frame count for a waveform (end-padded patches)."""
    secs = samples / float(rate)
    if secs <= config.YAMNET_WINDOW:
        return 1
    return int(math.ceil((secs - config.YAMNET_WINDOW) / config.YAMNET_HOP - 1e-9)) + 1


class YamnetScorer:
    """YAMNet ONNX: input ``waveform`` float32 [N] in [-1, 1] at 16 kHz;
    output 0 = [frames, 521] class scores."""

    name = "yamnet"

    def __init__(self, models_dir: str, session_factory: Callable[[Any], Any]) -> None:
        path = os.path.join(models_dir, config.YAMNET_FILE)
        if not os.path.isfile(path):
            raise ModelMissing("sound model (YAMNet) not found in %s" % models_dir)
        self.names = load_class_names(class_map_path(models_dir))
        self.sess = session_factory(path)
        self.inp = self.sess.get_inputs()[0].name

    def score(self, pcm: np.ndarray, t0: float) -> np.ndarray:  # noqa: ARG002 - t0 used by the fed scorer
        x = np.ascontiguousarray(pcm, dtype=np.float32)
        min_len = int(config.YAMNET_WINDOW * config.AUDIO_RATE)
        if x.size < min_len:
            x = np.concatenate([x, np.zeros(min_len - x.size, np.float32)])
        out = self.sess.run(None, {self.inp: x})[0]
        return np.asarray(out, dtype=np.float32)

    def close(self) -> None:
        self.sess = None
        gc.collect()


class FedAudioScorer:
    """Test hook (--scores-from "audioClasses"): per-second class scores
    {AudioSet display name: per-second array}; each frame takes the value at
    its centre second. Exercises decode, chunking, mapping and checkpoints
    without a model."""

    name = "scores-from"

    def __init__(self, class_arrays: Dict[str, np.ndarray], names: Sequence[str]) -> None:
        self.names = list(names)
        index = {n: i for i, n in enumerate(self.names)}
        self.cols = []
        for cls, arr in sorted(class_arrays.items()):
            if cls not in index:
                raise ValueError("unknown AudioSet class %r" % cls)
            self.cols.append((index[cls], np.asarray(arr, dtype=np.float32)))
        self.calls: List[float] = []

    def score(self, pcm: np.ndarray, t0: float) -> np.ndarray:
        self.calls.append(round(t0, 3))
        f = frame_count(len(pcm))
        out = np.zeros((f, len(self.names)), dtype=np.float32)
        for k in range(f):
            centre = t0 + k * config.YAMNET_HOP + config.YAMNET_WINDOW / 2.0
            i = int(math.floor(centre))
            for col, arr in self.cols:
                if 0 <= i < len(arr):
                    out[k, col] = arr[i]
        return out

    def close(self) -> None:
        pass
