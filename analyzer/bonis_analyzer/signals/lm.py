"""Dialogue LM scorer: Qwen3-0.6B (GGUF) through llama-cpp-python.

60 s windows with a 15 s stride; few-shot ChatML prompt asking for JSON only,
the answer prefilled with its first key, temperature 0; returns per-category scores 0..1. Windows are budgeted
(see ``select_windows``). The LM is optional: when llama-cpp-python or the
model file is missing the scan continues with the keyword scorer alone.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

from .. import config

CATS = config.LM_CATEGORIES

SYSTEM = (
    "You label one minute of movie subtitles for a parental filter. For each label give a number from 0 "
    "(absent) to 10 (clearly present):\n"
    "nudity = someone is naked; sex = sexual activity; implied = sex suggested or off-screen; "
    "kissing = heavy kissing; gore = blood, wounds or graphic violence.\n"
    "Most minutes of a film are 0 for every label. Answer with JSON only."
)
# Few-shot examples (synthetic, non-explicit). The model answers 0..10; scores are /10.
SHOTS = (
    ("We need to finish the report by Monday.\nI'll call you after lunch.",
     {"nudity": 0, "sex": 0, "implied": 0, "kissing": 0, "gore": 0}),
    ("[gunfire]\nHe's been shot! There's so much blood!\n[groaning in pain]",
     {"nudity": 0, "sex": 0, "implied": 0, "kissing": 0, "gore": 8}),
    ("Stay with me tonight.\n[door closes]\n[soft music]\n[sighs]",
     {"nudity": 0, "sex": 2, "implied": 7, "kissing": 2, "gore": 0}),
    ("[they kiss passionately]\nI missed you so much.\n[kissing]",
     {"nudity": 0, "sex": 1, "implied": 2, "kissing": 8, "gore": 0}),
    ("[moaning]\n[heavy breathing]\nDon't stop.",
     {"nudity": 2, "sex": 8, "implied": 6, "kissing": 2, "gore": 0}),
)
ANSWER_PREFIX = '{"nudity": '


def _msg(role: str, content: str) -> str:
    return "<|im_start|>%s\n%s<|im_end|>\n" % (role, content)


def _user(text: str) -> str:
    return "Subtitles:\n<<<\n%s\n>>>\nJSON with keys nudity, sex, implied, kissing, gore. /no_think" % text


def build_prompt(text: str) -> str:
    """Qwen3 ChatML prompt; thinking disabled; the answer's first key is prefilled
    so the model only writes numbers (fast, and always JSON)."""
    text = text.replace("<|", "< |")  # subtitles cannot inject chat-template tokens
    p = _msg("system", SYSTEM)
    for t, a in SHOTS:
        p += _msg("user", _user(t)) + _msg("assistant", "<think>\n\n</think>\n\n" + json.dumps(a))
    return p + _msg("user", _user(text)) + "<|im_start|>assistant\n<think>\n\n</think>\n\n" + ANSWER_PREFIX


def available() -> bool:
    try:
        import llama_cpp  # noqa: F401, PLC0415
    except Exception:  # noqa: BLE001
        return False
    return True


def parse_answer(text: str, scale10: bool = False) -> Dict[str, float]:
    """First JSON object in ``text`` -> category scores 0..1 (missing = 0).
    Values on a 0..10 scale (``scale10`` or any value > 1) are divided by 10."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    m = re.search(r"\{.*?\}", text, flags=re.S)
    out = {c: 0.0 for c in CATS}
    if not m:
        return out
    try:
        obj = json.loads(m.group(0))
    except ValueError:
        return out
    if not isinstance(obj, dict):
        return out
    vals = {}
    for c in CATS:
        v = obj.get(c)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
            continue
        vals[c] = float(v)
    scale = 10.0 if any(v > 1.0 for v in vals.values()) or scale10 else 1.0
    for c, v in vals.items():
        out[c] = float(min(1.0, max(0.0, v / scale)))
    return out


class LlamaLM:
    """Real scorer. Construct once per stage; call ``close()`` (then gc) after.
    The constant few-shot prefix stays in llama.cpp's KV cache between windows."""

    def __init__(self, model_path: str, threads: int = 2, gpu: bool = False, n_ctx: int = 2048) -> None:
        from llama_cpp import Llama  # noqa: PLC0415

        self.llm = Llama(model_path=model_path, n_ctx=n_ctx, n_threads=max(1, threads), n_batch=512,
                         n_gpu_layers=-1 if gpu else 0, seed=0, verbose=False)

    def score(self, text: str) -> Dict[str, float]:
        res = self.llm.create_completion(build_prompt(text), max_tokens=48, temperature=0.0, top_k=1,
                                         stop=["}"], seed=0)
        return parse_answer(ANSWER_PREFIX + (res["choices"][0].get("text") or "") + "}", scale10=True)

    def close(self) -> None:
        llm = getattr(self, "llm", None)
        self.llm = None
        if llm is not None:
            try:
                llm.close()
            except Exception:  # noqa: BLE001
                pass
        del llm


class FakeLM:
    """Deterministic stand-in for tests: substring rules -> scores."""

    def __init__(self, rules: Optional[Dict[str, Dict[str, float]]] = None,
                 fn: Optional[Callable[[str], Dict[str, float]]] = None) -> None:
        self.rules = rules or {}
        self.fn = fn
        self.calls: List[str] = []

    def score(self, text: str) -> Dict[str, float]:
        self.calls.append(text)
        if self.fn is not None:
            return parse_answer(json.dumps(self.fn(text)))
        out = {c: 0.0 for c in CATS}
        low = text.lower()
        for needle, sc in sorted(self.rules.items()):
            if needle.lower() in low:
                for c, v in sc.items():
                    if c in out:
                        out[c] = max(out[c], float(v))
        return out

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------
# windows
# --------------------------------------------------------------------------


def window_starts(duration: float, window: float = config.LM_WINDOW, stride: float = config.LM_STRIDE) -> List[float]:
    if duration <= window:
        return [0.0]
    starts = [i * stride for i in range(int(math.floor((duration - window) / stride)) + 1)]
    if starts[-1] + window < duration:
        starts.append(float(duration - window))
    return starts


def _span(start: float, n: int, length: float) -> slice:
    a = max(0, int(math.floor(start)))
    b = min(n, int(math.ceil(start + length)))
    return slice(a, max(a, b))


def select_windows(starts: Sequence[float], kw: Dict[str, np.ndarray], frames: Optional[Dict[str, np.ndarray]],
                   n: int, has_text: Callable[[float], bool],
                   top: int = config.LM_TOP_WINDOWS, budget: int = config.LM_MAX_WINDOWS,
                   frame_trigger: float = config.LM_FRAME_TRIGGER) -> List[int]:
    """Indices of windows worth an LM call.

    A window is scored when its keyword pre-filter score > 0 OR a frame score
    in it (or the neighbouring stride) exceeds ``frame_trigger``; the ``top``
    windows by keyword score are always included. Windows without dialogue
    are never sent. Over ``budget``, the highest keyword/frame scores win.
    """
    pri = []
    for i, s in enumerate(starts):
        if not has_text(s):
            continue
        sl = _span(s, n, config.LM_WINDOW)
        k = max((float(a[sl].max()) if a[sl].size else 0.0) for c, a in kw.items() if c in CATS) if kw else 0.0
        fsl = _span(s - config.LM_STRIDE, n, config.LM_WINDOW + 2 * config.LM_STRIDE)
        f = 0.0
        if frames:
            f = max((float(a[fsl].max()) if a[fsl].size else 0.0) for c, a in frames.items() if c in CATS)
        pri.append((i, k, f))
    chosen = {i for i, k, f in pri if k > 0 or f > frame_trigger}
    by_kw = sorted(pri, key=lambda x: (-x[1], x[0]))
    chosen.update(i for i, _, _ in by_kw[:top])
    if len(chosen) > budget:
        ranked = sorted((x for x in pri if x[0] in chosen), key=lambda x: (-max(x[1], x[2]), x[0]))
        chosen = {i for i, _, _ in ranked[:budget]}
    return sorted(chosen)


def spread(starts: Sequence[float], scores: Dict[int, Dict[str, float]], n: int) -> Dict[str, np.ndarray]:
    """Window scores -> per-second arrays. Each window owns its central
    stride-long core (so every second takes the score of the window centred
    on it); max where cores overlap at the ends."""
    out = {c: np.zeros(n, dtype=np.float32) for c in CATS}
    half = config.LM_STRIDE / 2.0
    for i, sc in scores.items():
        s = starts[i]
        centre = s + config.LM_WINDOW / 2.0
        a, b = centre - half, centre + half
        if i == 0:
            a = 0.0
        if i == len(starts) - 1:
            b = float(n)
        sl = _span(a, n, b - a)
        for c in CATS:
            v = float(sc.get(c, 0.0))
            if v > 0:
                seg = out[c][sl]
                np.maximum(seg, v, out=seg)
    return out
