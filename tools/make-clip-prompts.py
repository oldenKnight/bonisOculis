#!/usr/bin/env python3
"""Build-time: encode the CLIP zero-shot prompts into analyzer/models/clip_prompts.npz.

Reads the prompt sets from analyzer/bonis_analyzer/signals/clip_prompts.py,
loads the CLIP text encoder (int8 ONNX) and tokenizer.json from
$BONIS_MODELS_DIR (or --models), writes float32 L2-normalised embeddings
plus a JSON index. Needs: onnxruntime, numpy, tokenizers (build only).

    BONIS_MODELS_DIR=/path/to/models python3 tools/make-clip-prompts.py
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS_PY = os.path.join(ROOT, "analyzer", "bonis_analyzer", "signals", "clip_prompts.py")
OUT_DIR = os.path.join(ROOT, "analyzer", "models")
TEXT_MODEL = "clip-vit-b32-text_quantized.onnx"
TOKENIZER = "clip-vit-b32-tokenizer.json"
CONTEXT = 77


def load_prompts():
    spec = importlib.util.spec_from_file_location("clip_prompts", PROMPTS_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # our own repository file, not model data
    return mod.PROMPTS, mod.GROUPS


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.environ.get("BONIS_MODELS_DIR", ""))
    ap.add_argument("--out", default=OUT_DIR)
    a = ap.parse_args()
    if not a.models:
        sys.exit("set BONIS_MODELS_DIR or pass --models")
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(os.path.join(a.models, TOKENIZER))  # JSON data, no code
    model_path = os.path.join(a.models, TEXT_MODEL)
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    prompts, groups = load_prompts()
    texts, gidx = [], []
    for gi, g in enumerate(groups):
        for p in prompts[g]:
            texts.append(p)
            gidx.append(gi)
    embs = []
    for t in texts:
        ids = tok.encode(t.lower()).ids[:CONTEXT]
        # One prompt at a time: no padding, so EOS pooling (argmax id) is exact.
        out = sess.run(None, {in_name: np.array([ids], dtype=np.int64)})[0]
        embs.append(out[0])
    e = np.asarray(embs, dtype=np.float32)
    e /= np.linalg.norm(e, axis=1, keepdims=True)
    os.makedirs(a.out, exist_ok=True)
    npz = os.path.join(a.out, "clip_prompts.npz")
    np.savez(npz, embeddings=e.astype(np.float32), groups=np.asarray(gidx, dtype=np.int64),
             group_names=np.asarray(groups, dtype="<U16"))
    index = {
        "file": "clip_prompts.npz", "dim": int(e.shape[1]), "count": len(texts),
        "textModel": TEXT_MODEL, "textModelSha256": sha256(model_path),
        "groups": groups, "prompts": [{"group": groups[g], "text": t} for t, g in zip(texts, gidx)],
    }
    with open(os.path.join(a.out, "clip_prompts.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=1)
        f.write("\n")
    print("wrote %s (%d prompts, dim %d)" % (npz, len(texts), e.shape[1]))


if __name__ == "__main__":
    main()
