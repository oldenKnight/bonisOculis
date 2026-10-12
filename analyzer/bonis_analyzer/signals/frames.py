"""Frames signal: the AdamCodd/vit-base-nsfw-detector classifier (nudity)
+ CLIP ViT-B/32 int8 zero-shot (sex, kissing, implied, gore, and a nudity
prompt group fused with the classifier) on 1 fps frames from the decode pipe.

All preprocessing is numpy; nothing touches disk. Scorers take a batch of
(timestamp, HxWx3 uint8 RGB) frames and return one {category: score} per frame.
"""

from __future__ import annotations

import gc
import json
import os
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


def nsfw_preprocess(img: np.ndarray, size: int = config.NSFW_SIZE,
                    mean: Sequence[float] = config.NSFW_MEAN, std: Sequence[float] = config.NSFW_STD) -> np.ndarray:
    """ViTImageProcessor: plain resize to size x size (aspect not kept, as the
    model was trained), rescale 1/255, normalise; CHW float32."""
    r = resize_bilinear(img[:, :, :3], size, size) / 255.0
    r = (r - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)
    return np.ascontiguousarray(r.transpose(2, 0, 1), dtype=np.float32)


def softmax(logits: np.ndarray) -> np.ndarray:
    """Row-wise softmax, float64 internally (rows sum to 1)."""
    x = np.asarray(logits, dtype=np.float64)
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


def fuse_nudity(classifier: float, clip_group: float, weight: float = config.CLIP_NUDITY_WEIGHT) -> float:
    """Frame nudity = max(classifier nsfw probability, weight x CLIP nudity group)."""
    return float(min(1.0, max(0.0, classifier, weight * clip_group)))


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


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, ValueError) as e:
        raise ModelMissing("nudity model settings are damaged (%s); reinstall bonis oculis" % os.path.basename(path)) from e
    if not isinstance(obj, dict):
        raise ModelMissing("nudity model settings are damaged (%s); reinstall bonis oculis" % os.path.basename(path))
    return obj


def nsfw_settings(models_dir: str) -> Dict[str, Any]:
    """Preprocessing and the nsfw logit index from the model's own JSON files
    (data only); config.py defaults when a file is absent. Values are checked,
    never trusted blindly: a size or statistics we cannot use is an error."""
    out: Dict[str, Any] = {"size": config.NSFW_SIZE, "mean": tuple(config.NSFW_MEAN),
                           "std": tuple(config.NSFW_STD), "index": 1}
    pre = os.path.join(models_dir, config.NSFW_PREPROCESSOR_FILE)
    if os.path.isfile(pre):
        p = _read_json(pre)
        size = p.get("size")
        if isinstance(size, dict):
            h, w = size.get("height"), size.get("width")
            if not (isinstance(h, int) and h == w and 32 <= h <= 1024):
                raise ModelMissing("nudity model settings are unsupported (size %r)" % (size,))
            out["size"] = h
        for k, key in (("mean", "image_mean"), ("std", "image_std")):
            v = p.get(key)
            if v is not None:
                if not (isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) for x in v)
                        and (k == "mean" or all(x > 0 for x in v))):
                    raise ModelMissing("nudity model settings are unsupported (%s)" % key)
                out[k] = tuple(float(x) for x in v)
    cfg = os.path.join(models_dir, config.NSFW_CONFIG_FILE)
    if os.path.isfile(cfg):
        labels = _read_json(cfg).get("id2label")
        if isinstance(labels, dict):
            idx = [int(k) for k, v in labels.items() if str(v).lower() == config.NSFW_LABEL and str(k).isdigit()]
            if len(idx) != 1 or idx[0] not in (0, 1) or len(labels) != 2:
                raise ModelMissing("nudity model settings are unsupported (labels %r)" % (labels,))
            out["index"] = idx[0]
    return out


def prompts_path(models_dir: str) -> str:
    here = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "models")
    for d in (models_dir, here):
        p = os.path.join(d, config.CLIP_PROMPTS_FILE)
        if os.path.isfile(p):
            return p
    raise ModelMissing("CLIP prompt embeddings (%s) not found" % config.CLIP_PROMPTS_FILE)


class ModelFrameScorer:
    """nsfw classifier + CLIP. Both ORT sessions are the frames stage's model
    set; ``close()`` releases them before the next stage loads anything."""

    def __init__(self, models_dir: str, session_factory: Callable[[Any], Any]) -> None:
        nsfw_path = os.path.join(models_dir, config.NSFW_FILE)
        if not os.path.isfile(nsfw_path):
            raise ModelMissing("nudity model (%s) not found in %s" % (config.NSFW_FILE, models_dir))
        clip_path = os.path.join(models_dir, config.CLIP_VISION_FILE)
        if not os.path.isfile(clip_path):
            raise ModelMissing("picture model (CLIP) not found in %s" % models_dir)
        self.prompts, self.groups, self.names = load_prompts(prompts_path(models_dir))
        self.nsfw_cfg = nsfw_settings(models_dir)
        self.nsfw = session_factory(nsfw_path)
        self.nsfw_in = self.nsfw.get_inputs()[0].name
        self.clip = session_factory(clip_path)
        self.clip_in = self.clip.get_inputs()[0].name

    def nsfw_logits(self, frames: Sequence[np.ndarray]) -> np.ndarray:
        """[N, 2] logits, the classifier run in batches of config.NSFW_BATCH."""
        c = self.nsfw_cfg
        out = []
        for i in range(0, len(frames), config.NSFW_BATCH):
            batch = np.stack([nsfw_preprocess(f, c["size"], c["mean"], c["std"])
                              for f in frames[i:i + config.NSFW_BATCH]])
            raw = np.asarray(self.nsfw.run(None, {self.nsfw_in: batch})[0], dtype=np.float32)
            if raw.ndim != 2 or raw.shape != (len(batch), 2):
                raise ValueError("nudity model returned shape %r" % (raw.shape,))
            out.append(raw)
        return np.concatenate(out) if out else np.zeros((0, 2), np.float32)

    def classify(self, frames: Sequence[np.ndarray]) -> np.ndarray:
        """nsfw probability per frame (softmax over the two logits)."""
        if not len(frames):
            return np.zeros(0, np.float64)
        return softmax(self.nsfw_logits(frames))[:, self.nsfw_cfg["index"]]

    def embed(self, frames: Sequence[np.ndarray]) -> np.ndarray:
        batch = np.stack([clip_preprocess(f) for f in frames])
        return np.asarray(self.clip.run(None, {self.clip_in: batch})[0], dtype=np.float32)

    def score_batch(self, batch: Sequence[Frame]) -> List[Scores]:
        if not batch:
            return []
        imgs = [f for _, f in batch]
        probs = self.classify(imgs)
        zs = zero_shot(self.embed(imgs), self.prompts, self.groups, self.names)
        out = []
        for p, z in zip(probs, zs):
            s = {c: 0.0 for c in config.VISUAL_CATEGORIES}
            s["nudity"] = fuse_nudity(float(p), float(z.get(config.CLIP_NUDITY_GROUP, 0.0)))
            for g, cat in config.CLIP_GROUP_CATEGORY.items():
                if g in z:
                    s[cat] = max(s[cat], float(z[g]))
            out.append(s)
        return out

    def close(self) -> None:
        self.nsfw = None
        self.clip = None
        gc.collect()


class FedFrameScorer:
    """Test hook (--scores-from): looks frame scores up in provided per-second
    arrays. ``parts`` (the "framesParts" key) feeds the two nudity inputs
    instead, {"nsfw": classifier probability, "clipNudity": CLIP nudity group},
    so a fed scan runs the same fusion (fuse_nudity) as the real scorer; a fed
    "nudity" array, when also given, is max()ed with the fused value."""

    def __init__(self, arrays: Dict[str, np.ndarray], parts: Optional[Dict[str, np.ndarray]] = None) -> None:
        self.arrays = arrays
        self.parts = parts or {}

    def score_batch(self, batch: Sequence[Frame]) -> List[Scores]:
        def at(a: np.ndarray, i: int) -> float:
            return float(a[i]) if 0 <= i < len(a) else 0.0

        out = []
        for t, _ in batch:
            i = int(round(t))
            s = {c: at(a, i) for c, a in self.arrays.items()}
            if self.parts:
                fused = fuse_nudity(at(self.parts.get("nsfw", np.zeros(0)), i),
                                    at(self.parts.get("clipNudity", np.zeros(0)), i))
                s["nudity"] = max(s.get("nudity", 0.0), fused)
            out.append(s)
        return out

    def close(self) -> None:
        pass


