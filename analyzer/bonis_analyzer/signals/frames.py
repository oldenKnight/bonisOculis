"""Frames signal: NudeNet 320n (nudity) + CLIP ViT-B/32 int8 zero-shot
(sex, kissing, implied, gore) on 1 fps frames from the decode pipe.

All preprocessing is numpy; nothing touches disk. Scorers take a batch of
(timestamp, HxWx3 uint8 RGB) frames and return one {category: score} per frame.
"""

from __future__ import annotations

import gc

import os
import tarfile
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .. import config
from ..protocol import ModelMissing

Frame = Tuple[float, np.ndarray]
Scores = Dict[str, float]

# --------------------------------------------------------------------------
# numpy image helpers
# --------------------------------------------------------------------------


def resize_bilinear(img: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    """HxWxC uint8/float -> out_h x out_w x C float32 (half-pixel centres)."""
    h, w = img.shape[:2]
    src = img.astype(np.float32)
    if (h, w) == (out_h, out_w):
        return src
    ys = (np.arange(out_h, dtype=np.float32) + 0.5) * (h / out_h) - 0.5
    xs = (np.arange(out_w, dtype=np.float32) + 0.5) * (w / out_w) - 0.5
    ys = np.clip(ys, 0, h - 1)
    xs = np.clip(xs, 0, w - 1)
    y0 = np.floor(ys).astype(np.int64)
    x0 = np.floor(xs).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None, None]
    wx = (xs - x0)[None, :, None]
    top = src[y0][:, x0] * (1 - wx) + src[y0][:, x1] * wx
    bot = src[y1][:, x0] * (1 - wx) + src[y1][:, x1] * wx
    return top * (1 - wy) + bot * wy


def letterbox(img: np.ndarray, size: int = config.NUDENET_SIZE) -> Tuple[np.ndarray, float]:
    """Pad right/bottom to a square (black) and resize to size x size, as
    NudeNet's reference preprocessing does. Returns (CHW float32 0..1, scale)
    where scale maps model pixels back to source pixels."""
    h, w = img.shape[:2]
    m = max(h, w)
    sq = np.zeros((m, m, 3), dtype=np.uint8)
    sq[:h, :w] = img[:, :, :3]
    out = resize_bilinear(sq, size, size) / 255.0
    return np.ascontiguousarray(out.transpose(2, 0, 1), dtype=np.float32), m / float(size)


def clip_preprocess(img: np.ndarray, size: int = config.CLIP_SIZE) -> np.ndarray:
    """Shortest edge -> size, centre crop size x size, rescale, normalise; CHW float32."""
    h, w = img.shape[:2]
    if h <= w:
        nh, nw = size, max(size, int(round(w * size / h)))
    else:
        nh, nw = max(size, int(round(h * size / w))), size
    r = resize_bilinear(img[:, :, :3], nh, nw)
    top, left = (nh - size) // 2, (nw - size) // 2
    r = r[top:top + size, left:left + size] / 255.0
    r = (r - np.array(config.CLIP_MEAN, dtype=np.float32)) / np.array(config.CLIP_STD, dtype=np.float32)
    return np.ascontiguousarray(r.transpose(2, 0, 1), dtype=np.float32)


# --------------------------------------------------------------------------
# YOLOv8 (NudeNet) decoding
# --------------------------------------------------------------------------


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> List[int]:
    """Greedy class-agnostic NMS on xywh boxes (top-left origin). Deterministic."""
    if len(boxes) == 0:
        return []
    x1, y1 = boxes[:, 0], boxes[:, 1]
    x2, y2 = x1 + boxes[:, 2], y1 + boxes[:, 3]
    areas = np.maximum(0, boxes[:, 2]) * np.maximum(0, boxes[:, 3])
    order = np.lexsort((np.arange(len(scores)), -scores))
    keep: List[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        ov = np.where(union > 0, inter / np.maximum(union, 1e-9), 0)
        order = rest[ov <= iou]
    return keep


def decode_yolo(output: np.ndarray, scale: float = 1.0, labels: Sequence[str] = config.NUDENET_LABELS,
                min_score: float = config.NUDENET_MIN_SCORE, nms_score: float = config.NUDENET_NMS_SCORE,
                iou: float = config.NUDENET_NMS_IOU) -> List[Dict[str, Any]]:
    """One image's raw output (4 + classes, anchors) -> detections
    [{"class", "score", "box": [x, y, w, h]}] in source pixels."""
    out = np.asarray(output, dtype=np.float32)
    if out.ndim == 3:
        out = out[0]
    rows = out.T  # anchors x (4 + C)
    cls = rows[:, 4:]
    best = cls.argmax(axis=1)
    conf = cls[np.arange(len(rows)), best]
    sel = conf >= max(min_score, nms_score)
    if not sel.any():
        return []
    r, best, conf = rows[sel], best[sel], conf[sel]
    cx, cy, w, h = r[:, 0], r[:, 1], r[:, 2], r[:, 3]
    boxes = np.stack([(cx - w / 2) * scale, (cy - h / 2) * scale, w * scale, h * scale], axis=1)
    dets = []
    for i in nms(boxes, conf, iou):
        dets.append({"class": labels[int(best[i])] if int(best[i]) < len(labels) else str(int(best[i])),
                     "score": float(conf[i]), "box": [float(v) for v in boxes[i]]})
    return dets


def nudity_score(dets: Sequence[Dict[str, Any]]) -> float:
    s = 0.0
    for d in dets:
        s = max(s, d["score"] * config.NUDENET_NUDITY_WEIGHTS.get(d["class"], 0.0))
    return float(min(1.0, s))


# --------------------------------------------------------------------------
# CLIP zero-shot
# --------------------------------------------------------------------------


def load_prompts(path: str) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    """clip_prompts.npz -> (embeddings P x D L2-normalised, group index per prompt, group names)."""
    with np.load(path, allow_pickle=False) as z:
        emb = np.asarray(z["embeddings"], dtype=np.float32)
        groups = np.asarray(z["groups"], dtype=np.int64)
        names = [str(x) for x in z["group_names"]]
    emb = emb / np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-9)
    return emb, groups, names


def zero_shot(image_emb: np.ndarray, prompts: np.ndarray, groups: np.ndarray, names: Sequence[str],
              logit_scale: float = config.CLIP_LOGIT_SCALE) -> List[Dict[str, float]]:
    """Softmax over all prompts (safe counter-prompts included), summed per
    group. Returns one {group_name: probability} per image."""
    e = image_emb / np.maximum(np.linalg.norm(image_emb, axis=1, keepdims=True), 1e-9)
    logits = logit_scale * (e @ prompts.T)
    logits = logits - logits.max(axis=1, keepdims=True)
    p = np.exp(logits)
    p = p / p.sum(axis=1, keepdims=True)
    out = []
    for row in p:
        g = np.zeros(len(names), dtype=np.float64)
        np.add.at(g, groups, row)
        out.append({names[i]: float(g[i]) for i in range(len(names))})
    return out


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------


def nudenet_source(models_dir: str) -> Any:
    """Path of 320n.onnx, or its bytes read (in memory) from the sdist tarball."""
    for name in config.NUDENET_FILES:
        p = os.path.join(models_dir, name)
        if os.path.isfile(p):
            return p
    tar = os.path.join(models_dir, config.NUDENET_TARBALL)
    if os.path.isfile(tar):
        with tarfile.open(tar, "r:gz") as t:
            member = t.getmember(config.NUDENET_TAR_MEMBER)
            if not member.isfile():
                raise ModelMissing("nudity model is damaged; reinstall bonis oculis")
            f = t.extractfile(member)
            if f is None:
                raise ModelMissing("nudity model is damaged; reinstall bonis oculis")
            return f.read()
    raise ModelMissing("nudity model (NudeNet 320n) not found in %s" % models_dir)


def prompts_path(models_dir: str) -> str:
    here = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "models")
    for d in (models_dir, here):
        p = os.path.join(d, config.CLIP_PROMPTS_FILE)
        if os.path.isfile(p):
            return p
    raise ModelMissing("CLIP prompt embeddings (%s) not found" % config.CLIP_PROMPTS_FILE)


class ModelFrameScorer:
    """NudeNet + CLIP. Both small ORT sessions are the frames stage's model set;
    ``close()`` releases them before the next stage loads anything."""

    def __init__(self, models_dir: str, session_factory: Callable[[Any], Any]) -> None:
        clip_path = os.path.join(models_dir, config.CLIP_VISION_FILE)
        if not os.path.isfile(clip_path):
            raise ModelMissing("picture model (CLIP) not found in %s" % models_dir)
        self.prompts, self.groups, self.names = load_prompts(prompts_path(models_dir))
        src = nudenet_source(models_dir)
        self.nude = session_factory(src)
        del src
        self.nude_in = self.nude.get_inputs()[0].name
        self.clip = session_factory(clip_path)
        self.clip_in = self.clip.get_inputs()[0].name

    def detect(self, frames: Sequence[np.ndarray]) -> List[List[Dict[str, Any]]]:
        boxes = [letterbox(f) for f in frames]
        batch = np.stack([b[0] for b in boxes])
        raw = self.nude.run(None, {self.nude_in: batch})[0]
        return [decode_yolo(raw[i], boxes[i][1]) for i in range(len(frames))]

    def embed(self, frames: Sequence[np.ndarray]) -> np.ndarray:
        batch = np.stack([clip_preprocess(f) for f in frames])
        return np.asarray(self.clip.run(None, {self.clip_in: batch})[0], dtype=np.float32)

    def score_batch(self, batch: Sequence[Frame]) -> List[Scores]:
        if not batch:
            return []
        imgs = [f for _, f in batch]
        dets = self.detect(imgs)
        zs = zero_shot(self.embed(imgs), self.prompts, self.groups, self.names)
        out = []
        for d, z in zip(dets, zs):
            s = {c: 0.0 for c in config.VISUAL_CATEGORIES}
            s["nudity"] = nudity_score(d)
            for g, cat in config.CLIP_GROUP_CATEGORY.items():
                if g in z:
                    s[cat] = max(s[cat], float(z[g]))
            out.append(s)
        return out

    def close(self) -> None:
        self.nude = None
        self.clip = None
        gc.collect()


class FedFrameScorer:
    """Test hook (--scores-from): looks frame scores up in provided per-second arrays."""

    def __init__(self, arrays: Dict[str, np.ndarray]) -> None:
        self.arrays = arrays

    def score_batch(self, batch: Sequence[Frame]) -> List[Scores]:
        out = []
        for t, _ in batch:
            i = int(round(t))
            s = {}
            for c, a in self.arrays.items():
                s[c] = float(a[i]) if 0 <= i < len(a) else 0.0
            out.append(s)
        return out

    def close(self) -> None:
        pass


