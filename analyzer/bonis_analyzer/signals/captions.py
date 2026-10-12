"""Scene-description signal: Florence-2 base-ft (q4f16 ONNX) captions one
keyframe per shot; the caption is scored by the English lexicon and, for shots
whose caption mentions people, by the dialogue LM with a caption prompt
(signals/lm.py). Only scores are kept: caption text lives in memory during the
stage and is never written to disk, the skip file, notes or thumbnails.

Generation is a hand-written greedy loop over four ONNX graphs (no
transformers library):

    pixel_values [1,3,768,768] --vision_encoder--> image_features [1,577,768]
    prompt ids --embed_tokens--> [1,P,768]; concat -> encoder -> hidden [1,577+P,768]
    decoder_model_merged: step 0 without cache (use_cache_branch=False),
    then one token per step with the decoder self-attention cache; the
    cross-attention cache from step 0 is reused.

Greedy with Florence's own generation settings where they apply to greedy
search: forced BOS after the decoder start token, no_repeat_ngram_size 3, stop
at EOS, at most CAPTION_MAX_TOKENS new tokens (beam search with 3 beams, the
model default, is replaced by greedy: 3x cheaper, see analyzer/README.md).
"""

from __future__ import annotations

import gc
import json
import math
import os
import re
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .. import config
from ..protocol import ModelMissing
from . import onnx_fix

_HERE_MODELS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "models")
CAPTION_CATEGORIES = ("nudity", "sex", "implied", "kissing", "gore")

# --------------------------------------------------------------------------
# shots and budget
# --------------------------------------------------------------------------


def shots_from_cuts(cuts: Optional[Sequence[float]], duration: float, max_shot: float = config.CAPTION_MAX_SHOT,
                    no_cuts_step: float = config.CAPTION_NO_CUTS_STEP) -> List[Tuple[float, float]]:
    """Shots [start, end) between consecutive scene cuts; shots longer than
    ``max_shot`` are split evenly. ``cuts is None`` (unknown) -> fixed steps."""
    duration = max(0.0, float(duration))
    if duration <= 0:
        return []
    if cuts is None:
        bounds = [0.0]
        t = no_cuts_step
        while t < duration - 1e-6:
            bounds.append(round(t, 3))
            t += no_cuts_step
        bounds.append(duration)
    else:
        bounds = [0.0] + sorted({round(float(c), 3) for c in cuts if 0.0 < float(c) < duration}) + [duration]
    out: List[Tuple[float, float]] = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a <= 1e-6:
            continue
        parts = max(1, int(math.ceil((b - a) / max_shot - 1e-9)))
        step = (b - a) / parts
        for i in range(parts):
            out.append((round(a + i * step, 3), round(b if i == parts - 1 else a + (i + 1) * step, 3)))
    return out


def shot_priority(shots: Sequence[Tuple[float, float]], other: np.ndarray) -> np.ndarray:
    """Max of the other signals (any category) inside each shot."""
    n = len(other)
    pr = np.zeros(len(shots), dtype=np.float32)
    for i, (a, b) in enumerate(shots):
        lo, hi = max(0, int(math.floor(a))), min(n, max(int(math.ceil(b)), int(math.floor(a)) + 1))
        if hi > lo:
            pr[i] = float(other[lo:hi].max())
    return pr


def select_shots(priority: np.ndarray, budget: int = config.CAPTION_MAX_SHOTS,
                 threshold: float = config.CAPTION_PRIORITY) -> List[int]:
    """All shots when within budget. Over budget: every shot whose other-signal
    score reaches ``threshold`` (highest first if even those exceed the budget)
    plus an even sample of the rest filling the budget. Deterministic."""
    m = len(priority)
    if m <= budget:
        return list(range(m))
    hot = [i for i in range(m) if priority[i] >= threshold - 1e-9]
    if len(hot) >= budget:
        hot.sort(key=lambda i: (-float(priority[i]), i))
        return sorted(hot[:budget])
    rest = [i for i in range(m) if priority[i] < threshold - 1e-9]
    k = budget - len(hot)
    picked = [rest[int(math.floor((j + 0.5) * len(rest) / k))] for j in range(k)] if k > 0 and rest else []
    return sorted(set(hot) | set(picked))


def spread(shots: Sequence[Tuple[float, float]], scores: Dict[int, Dict[str, float]], n: int) -> Dict[str, np.ndarray]:
    """Per-shot scores -> per-second arrays (a caption speaks for its whole shot)."""
    out = {c: np.zeros(n, dtype=np.float32) for c in CAPTION_CATEGORIES}
    for i, sc in scores.items():
        a, b = shots[i]
        lo, hi = max(0, int(math.floor(a))), min(n, max(int(math.ceil(b)), int(math.floor(a)) + 1))
        for c in CAPTION_CATEGORIES:
            v = float(sc.get(c, 0.0))
            if v > 0 and hi > lo:
                seg = out[c][lo:hi]
                np.maximum(seg, v, out=seg)
    return out


# --------------------------------------------------------------------------
# caption text -> scores (text never leaves this process)
# --------------------------------------------------------------------------

_PEOPLE = re.compile(
    r"\b(man|men|woman|women|person|people|persons|boy|boys|girl|girls|couple|couples|child|children|kid|kids|"
    r"lady|ladies|guy|guys|he|she|they|his|her|him|them|someone|somebody|body|bodies|figure|actor|actress|"
    r"male|female|teen|teenager|baby|human|humans|crowd|friends|lovers|husband|wife|mother|father)\b", re.I)


def mentions_people(text: str) -> bool:
    return bool(_PEOPLE.search(text or ""))


def lexicon_scores(text: str, lexicon: Any) -> Dict[str, float]:
    sc = lexicon.score_text(text or "")
    return {c: float(sc.get(c, 0.0)) for c in CAPTION_CATEGORIES}


# --------------------------------------------------------------------------
# Florence-2 prompt ids and byte-level BPE decoding
# --------------------------------------------------------------------------


def prompts_path(models_dir: Optional[str] = None) -> str:
    for d in ([models_dir] if models_dir else []) + [_HERE_MODELS]:
        p = os.path.join(d, config.FLORENCE_PROMPTS_FILE)
        if os.path.isfile(p):
            return p
    raise ModelMissing("caption prompt ids (%s) not found" % config.FLORENCE_PROMPTS_FILE)


def load_prompts(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    for k in ("promptIds", "bos", "eos", "pad", "decoderStart", "forcedBos", "specialIdRanges"):
        if k not in d:
            raise ModelMissing("caption prompt ids are damaged; reinstall bonis oculis")
    return d


def bytes_to_unicode() -> Dict[int, str]:
    """GPT-2 / BART byte <-> printable-unicode table."""
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, (chr(c) for c in cs)))


class ByteBpeDecoder:
    """ids -> text for a byte-level BPE vocab (tokenizer.json "model.vocab" +
    "added_tokens"): concatenate token strings, map each char back to its
    byte, UTF-8 decode (invalid sequences replaced), special ids skipped."""

    def __init__(self, vocab: Dict[str, int], added: Sequence[Dict[str, Any]] = (),
                 special_ranges: Sequence[Sequence[int]] = ()) -> None:
        size = max([int(i) for i in vocab.values()] + [int(a["id"]) for a in added] + [0]) + 1
        self.tokens: List[Optional[str]] = [None] * size
        for tok, i in vocab.items():
            self.tokens[int(i)] = tok
        self.added = set()
        for a in added:
            self.tokens[int(a["id"])] = a["content"]
            self.added.add(int(a["id"]))
        self.special = set()
        for lo, hi in special_ranges:
            self.special.update(range(int(lo), int(hi) + 1))
        self.byte_of = {c: b for b, c in bytes_to_unicode().items()}

    @classmethod
    def from_file(cls, tokenizer_json: str, special_ranges: Sequence[Sequence[int]]) -> "ByteBpeDecoder":
        with open(tokenizer_json, encoding="utf-8") as f:
            tj = json.load(f)  # data only
        model = tj.get("model") or {}
        if model.get("type") != "BPE" or not isinstance(model.get("vocab"), dict):
            raise ModelMissing("caption tokenizer is damaged; reinstall bonis oculis")
        return cls(model["vocab"], tj.get("added_tokens") or [], special_ranges)

    def decode(self, ids: Sequence[int], skip_special: bool = True) -> str:
        out = bytearray()
        for i in ids:
            i = int(i)
            if skip_special and i in self.special:
                continue
            tok = self.tokens[i] if 0 <= i < len(self.tokens) else None
            if tok is None:
                continue
            if i in self.added:
                out.extend(tok.encode("utf-8"))
                continue
            for ch in tok:
                b = self.byte_of.get(ch)
                if b is None:
                    out.extend(ch.encode("utf-8"))
                else:
                    out.append(b)
        return out.decode("utf-8", "replace").strip()


def preprocess(img: np.ndarray) -> np.ndarray:
    """768x768x3 uint8 RGB (ffmpeg already resized it, bicubic) -> [1,3,768,768]
    float32 rescaled and normalised with the ImageNet mean/std of
    florence2-preprocessor_config.json."""
    x = img[:, :, :3].astype(np.float32) * (1.0 / 255.0)
    x = (x - np.asarray(config.CAPTION_MEAN, dtype=np.float32)) / np.asarray(config.CAPTION_STD, dtype=np.float32)
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)


def banned_ngram_tokens(seq: Sequence[int], n: int) -> List[int]:
    """Tokens that would repeat an n-gram already in ``seq`` (HF no_repeat_ngram_size)."""
    if n <= 0 or len(seq) + 1 < n:
        return []
    prefix = tuple(seq[len(seq) - n + 1:]) if n > 1 else ()
    out = []
    for i in range(len(seq) - n + 1):
        if tuple(seq[i:i + n - 1]) == prefix:
            out.append(int(seq[i + n - 1]))
    return out


class FlorenceCaptioner:
    """The four Florence-2 graphs. ``caption(img, t)`` -> text (in memory)."""

    name = "florence2-base-ft-q4f16"

    def __init__(self, models_dir: str, session_factory: Callable[[Any], Any],
                 max_tokens: int = config.CAPTION_MAX_TOKENS) -> None:
        paths = {k: os.path.join(models_dir, f) for k, f in config.FLORENCE_FILES.items()}
        tok = os.path.join(models_dir, config.FLORENCE_TOKENIZER_FILE)
        missing = [p for p in list(paths.values()) + [tok] if not os.path.isfile(p)]
        if missing:
            raise ModelMissing("scene description model (Florence-2) not found in %s" % models_dir)
        self.p = load_prompts(prompts_path(models_dir))
        self.decoder_bpe = ByteBpeDecoder.from_file(tok, self.p["specialIdRanges"])
        self.max_tokens = int(max_tokens)
        self.vision = session_factory(paths["vision"])
        self.embed = session_factory(paths["embed"])
        self.encoder = session_factory(paths["encoder"])
        # ORT >= 1.2x rejects the q4f16 merged decoder as published; the repair is a no-op on a
        # healthy graph (~0.25 s), so it always runs: no failed first load, no spurious
        # "accelerator failed" fallback on DirectML / CoreML machines.
        with open(paths["decoder"], "rb") as f:
            raw = f.read()
        raw = onnx_fix.fix_model(raw)[0]
        self.decoder = session_factory(raw)
        del raw
        gc.collect()
        self.dec_inputs = [i.name for i in self.decoder.get_inputs()]
        self.dec_outputs = [o.name for o in self.decoder.get_outputs()]
        self.layers = sorted({int(n.split(".")[1]) for n in self.dec_inputs if n.startswith("past_key_values.")})
        prompt = np.asarray([self.p["promptIds"]], dtype=np.int64)
        self.prompt_embeds = self.embed.run(None, {"input_ids": prompt})[0].astype(np.float32)
        self.calls = 0

    def _embed(self, ids: Sequence[int]) -> np.ndarray:
        return self.embed.run(None, {"input_ids": np.asarray([list(ids)], dtype=np.int64)})[0].astype(np.float32)

    def generate(self, pixel_values: np.ndarray, max_tokens: Optional[int] = None) -> List[int]:
        max_tokens = self.max_tokens if max_tokens is None else int(max_tokens)
        img = self.vision.run(None, {"pixel_values": pixel_values})[0].astype(np.float32)
        embeds = np.concatenate([img, self.prompt_embeds], axis=1)
        mask = np.ones(embeds.shape[:2], dtype=np.int64)
        hidden = self.encoder.run(None, {"attention_mask": mask, "inputs_embeds": embeds})[0].astype(np.float32)
        del img, embeds
        seq = [int(self.p["decoderStart"])]
        past: Dict[str, np.ndarray] = {}
        enc_cache: Dict[str, np.ndarray] = {}
        generated: List[int] = []
        eos, nrng = int(self.p["eos"]), int(self.p.get("noRepeatNgram") or 0)
        for step in range(max_tokens):
            feed: Dict[str, Any] = {"encoder_attention_mask": mask, "encoder_hidden_states": hidden,
                                    "inputs_embeds": self._embed(seq[-1:])}
            first = step == 0
            for L in self.layers:
                for kind in ("decoder", "encoder"):
                    for kv in ("key", "value"):
                        name = "past_key_values.%d.%s.%s" % (L, kind, kv)
                        if first:
                            feed[name] = np.zeros((1, 12, 0, 64), dtype=np.float32)
                        elif kind == "decoder":
                            feed[name] = past[name]
                        else:
                            feed[name] = enc_cache[name]
            feed["use_cache_branch"] = np.array([not first], dtype=bool)
            outs = self.decoder.run(None, feed)
            res = dict(zip(self.dec_outputs, outs))
            logits = np.asarray(res["logits"][0, -1], dtype=np.float32)
            for L in self.layers:
                for kv in ("key", "value"):
                    past["past_key_values.%d.decoder.%s" % (L, kv)] = res["present.%d.decoder.%s" % (L, kv)]
                    if first:
                        enc_cache["past_key_values.%d.encoder.%s" % (L, kv)] = res["present.%d.encoder.%s" % (L, kv)]
            if first:
                tok = int(self.p["forcedBos"])
            else:
                for b in banned_ngram_tokens(seq, nrng):
                    logits[b] = -np.inf
                tok = int(np.argmax(logits))
            seq.append(tok)
            generated.append(tok)
            if tok == eos:
                break
        self.calls += 1
        return generated

    def caption(self, img: np.ndarray, t: float = 0.0) -> str:  # noqa: ARG002
        return self.decoder_bpe.decode(self.generate(preprocess(img)))

    def close(self) -> None:
        self.vision = self.embed = self.encoder = self.decoder = None
        self.prompt_embeds = None
        gc.collect()


class FakeCaptioner:
    """Test hook: captions by media time [(t_start, t_end, caption), ...]."""

    name = "scores-from"

    def __init__(self, entries: Sequence[Sequence[Any]] = ()) -> None:
        self.entries = [(float(a), float(b), str(c)) for a, b, c in entries]
        self.calls: List[float] = []

    def caption(self, img: Optional[np.ndarray], t: float = 0.0) -> str:  # noqa: ARG002
        self.calls.append(round(t, 3))
        return " ".join(c for a, b, c in self.entries if a <= t < b)

    def close(self) -> None:
        pass
