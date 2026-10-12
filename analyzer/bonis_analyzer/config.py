"""Analyzer constants: categories, levels -> thresholds (spec/SKIPFILE.md),
fusion weights and padding (docs/PLAN.md section 4).

Everything tunable lives here so evaluation runs can change one file.
"""

from __future__ import annotations

from typing import Dict, Optional

# Categories the analyzer scores. "other" is for manual marks only.
CATEGORIES = ("nudity", "sex", "implied", "kissing", "gore", "language")
VISUAL_CATEGORIES = ("nudity", "sex", "implied", "kissing", "gore")
# Categories the dialogue LM rates (profanity is left to the lexicon).
LM_CATEGORIES = VISUAL_CATEGORIES

SIGNALS = ("frames", "subtitles", "audio", "speech", "captions")

# spec/SKIPFILE.md "Levels -> thresholds"
LEVELS = ("off", "light", "moderate", "strict")
LEVEL_THRESHOLDS: Dict[str, Optional[float]] = {
    "off": None,
    "light": 0.80,
    "moderate": 0.60,
    "strict": 0.40,
}
LEVEL_ACTIONS = {"off": "none", "light": "skip", "moderate": "skip", "strict": "skip"}
# `language` defaults to mute at every level.
CATEGORY_ACTION_OVERRIDE = {"language": "mute"}

# Defaults when --levels omits a category: catch too much (brief 3.2),
# language off (SKIPFILE.md, ledger Q9).
DEFAULT_LEVELS = {
    "nudity": "strict",
    "sex": "strict",
    "implied": "strict",
    "kissing": "strict",
    "gore": "strict",
    "language": "off",
}

PRESETS = {
    "little-kids": {c: "strict" for c in CATEGORIES},
    "teens": {"nudity": "moderate", "sex": "moderate", "gore": "moderate",
              "implied": "light", "kissing": "light", "language": "off"},
}


def threshold(level: str) -> Optional[float]:
    return LEVEL_THRESHOLDS.get(level)


def default_action(category: str, level: str) -> str:
    if level == "off":
        return "none"
    return CATEGORY_ACTION_OVERRIDE.get(category, LEVEL_ACTIONS.get(level, "skip"))


# --------------------------------------------------------------------------
# fusion
# --------------------------------------------------------------------------

# Weight of each signal per category in the noisy-OR:
#   p = 1 - prod_s (1 - w[s][c] * score[s][c])
# Reasoning per weight: analyzer/TUNING.md. In short: frames strongest for
# nudity/gore; dialogue (subtitles, or speech-to-text when there are none)
# moderate for everything; sounds moderate for sex, weak for gore (a weighted
# audio gore score can never reach the strict threshold on its own); scene
# captions moderate for implied/sex/kissing.
SIGNAL_WEIGHTS: Dict[str, Dict[str, float]] = {
    "frames":    {"nudity": 1.00, "sex": 0.90, "implied": 0.70, "kissing": 0.85, "gore": 0.90, "language": 0.00},
    "subtitles": {"nudity": 0.70, "sex": 0.85, "implied": 0.85, "kissing": 0.75, "gore": 0.75, "language": 1.00},
    "speech":    {"nudity": 0.60, "sex": 0.75, "implied": 0.75, "kissing": 0.65, "gore": 0.65, "language": 0.90},
    "audio":     {"nudity": 0.00, "sex": 0.60, "implied": 0.50, "kissing": 0.00, "gore": 0.35, "language": 0.00},
    "captions":  {"nudity": 0.60, "sex": 0.70, "implied": 0.75, "kissing": 0.70, "gore": 0.60, "language": 0.00},
}

# Signal agreement: at a second where at least AGREE_MIN_SIGNALS signals from
# DIFFERENT groups each score >= AGREE_MIN, the fused score gets
#   p' = 1 - (1 - p) * (1 - AGREE_BONUS)
# (raises confidence, never above 1). Subtitles and speech are both dialogue
# and count as one group. Language is excluded (a single-source category).
AGREE_MIN = 0.30
AGREE_MIN_SIGNALS = 2
AGREE_BONUS = 0.25
SIGNAL_GROUPS = {"frames": "picture", "captions": "description", "subtitles": "dialogue",
                 "speech": "dialogue", "audio": "sound"}
AGREE_CATEGORIES = ("nudity", "sex", "implied", "kissing", "gore")

# A signal "agrees" for intensity and notes when its peak in the range is at
# least this high.
SIGNAL_PRESENT = 0.30

# Shot snapping and padding (PLAN section 4). Seconds.
MAX_SNAP = 20.0
MERGE_GAP = 3.0
LEAD_IN = 2.0
TAIL = 1.0
MIN_DURATION = 1.5           # default; per category below
# Minimum range length per category (shorter ranges are EXTENDED, never
# dropped: catch too much, brief 3.2). Sex/implied scenes are never a single
# beat, so a lone hit becomes a 3 s range a parent can judge from its thumbnail.
CATEGORY_MIN_DURATION = {"nudity": 1.5, "sex": 3.0, "implied": 3.0, "kissing": 2.0, "gore": 1.5,
                         "language": 1.0}

# Per-category overrides. Language ranges mute dialogue; snapping them to a
# whole shot and padding by 3 s would mute far more speech than the word
# itself, so they keep cue timing (see analyzer/README.md, deviations).
CATEGORY_TIMING = {
    "language": {"snap": False, "lead_in": 0.5, "tail": 0.5, "merge_gap": 1.0},
}

# Intensity: score bands, +1 when two or more signals agree.
INTENSITY_BANDS = ((0.85, 3), (0.65, 2), (0.0, 1))

# --------------------------------------------------------------------------
# subtitles / LM
# --------------------------------------------------------------------------

LM_WINDOW = 60.0
LM_STRIDE = 15.0
LM_TOP_WINDOWS = 20          # always score at least this many windows
LM_MAX_WINDOWS = 600         # hard budget (2.5 h at 15 s stride)
LM_FRAME_TRIGGER = 0.20      # a neighbouring frame score above this triggers a window
LM_WEIGHT = 0.85             # LM score scaled before max() with the keyword score
LM_MAX_CHARS = 1500

# --------------------------------------------------------------------------
# frames
# --------------------------------------------------------------------------

FRAME_FPS = 1
FRAME_WIDTH = 320
SCENE_WIDTH = 160
SCENE_THRESHOLD = 0.3
FRAME_BATCH = 8
CHECKPOINT_EVERY = 30.0      # media seconds between frame-stage checkpoints
RESUME_PREROLL = 2.0         # decode this much before resumeAt so cuts at resumeAt are seen
CUT_DEDUPE = 0.25

NUDENET_SIZE = 320
NUDENET_MIN_SCORE = 0.20
NUDENET_NMS_SCORE = 0.25
NUDENET_NMS_IOU = 0.45
# NudeNet 3.x labels, in model output order.
NUDENET_LABELS = (
    "FEMALE_GENITALIA_COVERED", "FACE_FEMALE", "BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED", "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "FEET_EXPOSED",
    "BELLY_COVERED", "FEET_COVERED", "ARMPITS_COVERED", "ARMPITS_EXPOSED", "FACE_MALE",
    "BELLY_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_COVERED", "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
)
# Detected class -> nudity weight (score * weight; max over detections).
NUDENET_NUDITY_WEIGHTS = {
    "FEMALE_GENITALIA_EXPOSED": 1.00,
    "MALE_GENITALIA_EXPOSED": 1.00,
    "ANUS_EXPOSED": 1.00,
    "FEMALE_BREAST_EXPOSED": 0.90,
    "BUTTOCKS_EXPOSED": 0.80,
    "FEMALE_GENITALIA_COVERED": 0.25,
}

CLIP_SIZE = 224
CLIP_LOGIT_SCALE = 100.0
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
# CLIP prompt group -> category it scores.
CLIP_GROUP_CATEGORY = {"sex": "sex", "kissing": "kissing", "implied": "implied", "gore": "gore"}

# --------------------------------------------------------------------------
# audio events (YAMNet, AudioSet 521 classes)
# --------------------------------------------------------------------------

AUDIO_RATE = 16000
AUDIO_CHUNK = 10.0           # seconds of new audio per model call
AUDIO_OVERLAP = 1.0          # seconds of the previous chunk prepended (frames across the seam)
AUDIO_CHECKPOINT_CHUNKS = 6  # flush audio.npz + resumeAt every 60 media seconds
YAMNET_HOP = 0.48
YAMNET_WINDOW = 0.96
# AudioSet display name -> {category: weight}. Category score of a 0.96 s frame
# = max over mapped classes of weight * class score; per second = max over the
# frames overlapping it. Names must exist in models/yamnet_class_map.csv
# (a test checks). Reasoning in analyzer/TUNING.md.
AUDIO_CLASS_MAP: Dict[str, Dict[str, float]] = {
    # vocal sounds of intimacy: sex, and at a lower weight implied
    "Wail, moan": {"sex": 0.90, "implied": 0.70},
    "Pant": {"sex": 0.70, "implied": 0.50},
    "Groan": {"sex": 0.60, "implied": 0.40},
    "Gasp": {"sex": 0.55, "implied": 0.40},
    "Whimper": {"sex": 0.50, "implied": 0.35},
    "Breathing": {"sex": 0.40, "implied": 0.30},
    "Grunt": {"sex": 0.40, "implied": 0.25},
    # violence. Screaming is capped at 0.50: with the audio->gore fusion weight
    # (0.35) it contributes at most 0.175, far below every gore threshold, so a
    # scream (horror, a roller coaster, a birthday surprise) never flags gore
    # alone; it only counts through the agreement bonus with another signal.
    "Gunshot, gunfire": {"gore": 0.80},
    "Machine gun": {"gore": 0.80},
    "Fusillade": {"gore": 0.70},
    "Squish": {"gore": 0.70},
    "Explosion": {"gore": 0.50},
    "Screaming": {"gore": 0.50},
    "Slap, smack": {"gore": 0.45},
    "Chop": {"gore": 0.45},
    "Crying, sobbing": {"gore": 0.30},
}
YAMNET_FILE = "yamnet.onnx"
# models/yamnet_class_map.csv: the official class map (Apache-2.0), committed, from
# https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv
# sha256 cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2 (fetched 2026-10-12)
YAMNET_CLASS_MAP_FILE = "yamnet_class_map.csv"
YAMNET_CLASS_MAP_SHA256 = "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2"
YAMNET_CLASSES = 521

# --------------------------------------------------------------------------
# speech to text (whisper.cpp small q5_1); only when no subtitles were found
# --------------------------------------------------------------------------

SPEECH_WINDOW = 30.0         # whisper's native context
SPEECH_OVERLAP = 2.0         # consecutive windows share 2 s; cues are split at the overlap midpoint
WHISPER_FILE = "whisper-small-q5_1.bin"
WHISPER_CLI_ENV = "BONIS_WHISPER_CLI"   # optional whisper-cli executable (fallback when pywhispercpp is missing)

# --------------------------------------------------------------------------
# scene captions (Florence-2 base-ft q4f16, ONNX Runtime)
# --------------------------------------------------------------------------

CAPTION_MAX_SHOTS = 300          # default budget (~20-25 min on an i5 CPU); --thorough raises it
CAPTION_MAX_SHOTS_THOROUGH = 1500
CAPTION_PRIORITY = 0.20      # shots where any other signal reaches this are always captioned
CAPTION_MAX_SHOT = 20.0      # longer shots are split so a static 3-minute shot gets several keyframes
CAPTION_NO_CUTS_STEP = 10.0  # shot length when no scene cuts are known (frames stage not run)
CAPTION_MAX_TOKENS = 40
CAPTION_CHECKPOINT_SHOTS = 10
CAPTION_SIZE = 768
CAPTION_MEAN = (0.485, 0.456, 0.406)
CAPTION_STD = (0.229, 0.224, 0.225)
CAPTION_LM_WEIGHT = 0.85     # caption LM score scaled before max() with the caption lexicon score
FLORENCE_FILES = {
    "vision": "florence2-vision_encoder_q4f16.onnx",
    "embed": "florence2-embed_tokens_q4f16.onnx",
    "encoder": "florence2-encoder_model_q4f16.onnx",
    "decoder": "florence2-decoder_model_merged_q4f16.onnx",
}
FLORENCE_TOKENIZER_FILE = "florence2-tokenizer.json"
FLORENCE_PROMPTS_FILE = "florence_prompts.json"

# --------------------------------------------------------------------------
# thumbnails
# --------------------------------------------------------------------------

THUMB_WIDTH = 160
THUMB_BLUR = "boxblur=10:1"
MAX_THUMBS = 400

# --------------------------------------------------------------------------
# model files (analyzer/models/manifest.json names)
# --------------------------------------------------------------------------

NUDENET_FILES = ("nudenet-320n.onnx", "320n.onnx")
NUDENET_TARBALL = "nudenet-3.4.2.tar.gz"
NUDENET_TAR_MEMBER = "nudenet-3.4.2/nudenet/320n.onnx"
CLIP_VISION_FILE = "clip-vit-b32-vision_quantized.onnx"
CLIP_TEXT_FILE = "clip-vit-b32-text_quantized.onnx"
CLIP_TOKENIZER_FILE = "clip-vit-b32-tokenizer.json"
CLIP_PROMPTS_FILE = "clip_prompts.npz"
LM_FILE = "qwen3-0.6b-q4_k_m.gguf"
MODEL_SET = "nudenet-320n+clip-b32-int8+qwen3-0.6b-q4+yamnet+whisper-small-q5_1+florence2-base-ft-q4f16"
