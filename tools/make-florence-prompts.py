#!/usr/bin/env python3
"""Build-time: token ids of the Florence-2 caption task prompt and the special
token ids, written to analyzer/models/florence_prompts.json (committed).

The shipped analyzer never imports `tokenizers`: it embeds these ids directly
and decodes generated ids itself (byte-level BPE decode over the vocab in
florence2-tokenizer.json, see bonis_analyzer/signals/captions.py). The
"decodeChecks" entries let the tests prove that decoder matches the reference
`tokenizers` decode.

Florence2Processor turns a task token into its natural-language prompt
(florence2-preprocessor_config.json, task_prompts_without_inputs) and encodes
it with the BART tokenizer, <s> ... </s> included.

    BONIS_MODELS_DIR=/path/to/models python3 -I tools/make-florence-prompts.py
Needs: tokenizers (build only).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "analyzer", "models", "florence_prompts.json")
TOKENIZER = "florence2-tokenizer.json"
PREPROCESSOR = "florence2-preprocessor_config.json"
GENERATION = "florence2-generation_config.json"
TASK = "<MORE_DETAILED_CAPTION>"
# Plain, non-explicit sentences for the decoder round-trip check.
CHECK_TEXTS = [
    "A man in a blue shirt is standing in a kitchen.",
    "Two people are sitting on a couch, talking. The room has a lamp.",
    "A colorful test pattern with numbers, café and naïve accents, 3 circles.",
    "  leading spaces and a newline\nsecond line",
]


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ranges(ids):
    out = []
    for i in sorted(ids):
        if out and i == out[-1][1] + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.environ.get("BONIS_MODELS_DIR", ""))
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    if not a.models:
        sys.exit("set BONIS_MODELS_DIR or pass --models")
    from tokenizers import Tokenizer

    tok_path = os.path.join(a.models, TOKENIZER)
    tok = Tokenizer.from_file(tok_path)  # JSON data, no code
    with open(os.path.join(a.models, PREPROCESSOR), encoding="utf-8") as f:
        pre = json.load(f)
    with open(os.path.join(a.models, GENERATION), encoding="utf-8") as f:
        gen = json.load(f)
    text = pre["task_prompts_without_inputs"][TASK]
    if not isinstance(text, str) or len(text) > 200:
        sys.exit("unexpected task prompt")
    ids = tok.encode(text).ids
    with open(tok_path, encoding="utf-8") as f:
        tj = json.load(f)
    special = [int(t["id"]) for t in tj["added_tokens"] if t.get("special")]
    checks = []
    for t in CHECK_TEXTS:
        e = tok.encode(t).ids
        checks.append({"ids": e, "text": tok.decode(e, skip_special_tokens=True)})
    doc = {
        "task": TASK,
        "promptText": text,
        "promptIds": ids,
        "bos": int(gen["bos_token_id"]), "eos": int(gen["eos_token_id"]), "pad": int(gen["pad_token_id"]),
        "decoderStart": int(gen["decoder_start_token_id"]), "forcedBos": int(gen["forced_bos_token_id"]),
        "noRepeatNgram": int(gen.get("no_repeat_ngram_size") or 0),
        "vocabSize": int(tok.get_vocab_size(with_added_tokens=True)),
        "specialIdRanges": ranges(special),
        "tokenizer": TOKENIZER, "tokenizerSha256": sha256(tok_path),
        "decodeChecks": checks,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote %s (%d prompt ids, %d special ids)" % (a.out, len(ids), len(special)))


if __name__ == "__main__":
    main()
