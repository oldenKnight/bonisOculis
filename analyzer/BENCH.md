# Analyzer benchmarks (measured 2026-10-12)

Machine: this build container, 4 vCPU Intel Xeon @ 2.10 GHz (shared host),
16 GB RAM, CPU only (no GPU provider), Python 3.13, onnxruntime 1.29,
llama-cpp-python 0.3.36, pywhispercpp 1.5.1, ffmpeg 6.1. Real-film timing on
the owner's i5 will differ; rerun with `scan --profile`.

Input: a synthetic 60 s clip, `testsrc2` 640x360 @ 24 fps (x264, GOP 2 s) +
440 Hz sine (AAC), no subtitles, so every stage runs (speech-to-text included):

```
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24:duration=60 -f lavfi -i sine=frequency=440:duration=60 \
       -c:v libx264 -preset ultrafast -g 48 -pix_fmt yuv420p -c:a aac -shortest clip60.mp4
python -m bonis_analyzer scan --input clip60.mp4 --work w --out o.bonis.json --lang en-US \
       --threads {2|4} --device cpu --priority normal --profile
```

## Per stage (wall seconds incl. model load / peak resident memory)

`{"t":"profile"}` line. Peak RSS is per stage (Linux peak counter reset at each
stage start), analyzer process only (ffmpeg children excluded). 4 threads:
median of 3 runs; 2 threads: mean of 2 runs (they agreed within 5 %). The
shared host is noisy: one 4-thread run took 22 s for speech and 21 s for
captions.

| stage | work on the 60 s clip | 2 threads | 4 threads | peak RSS |
|---|---|---|---|---|
| subtitles | none found | 0.00 s | 0.00 s | 34 MB |
| speech (whisper small q5_1) | 3 windows of 30 s | 28.0 s | 16.1 s | 515 MB |
| frames (NudeNet 320n + CLIP B/32 int8) | 60 frames + scene cuts | 4.1 s | 3.5 s | 307-323 MB |
| audio (YAMNet) | 7 chunks of 10 s (+1 s overlap) | 0.49 s | 0.41 s | 149-159 MB |
| lm (Qwen3-0.6B Q4_K_M) | 1 window (speech cues) | 4.8 s | 4.5 s | 986 MB |
| captions (Florence-2 base-ft q4f16) | 3 shots (no cuts: 60 s split in 20 s shots), 40 tokens each | 18.4 s | 15.5 s | 956-1013 MB |
| fusion + output | | 0.01 s | 0.01 s | 107-111 MB |
| **whole scan** | | **~56 s** | **~40 s** | **986-1013 MB** |

Between stages the resident set falls back to ~110 MB: every stage releases
its model set (`models.release`: gc + glibc `malloc_trim`). Without the trim
the next stage started ~400 MB higher. The captions stage measured by the test
suite (`test_scan_v2.CaptionsMemoryTest`, 4 threads, `--stages frames,captions`)
peaked at 938-974 MB, under the 1.2 GB budget.

## Per unit (model load once per stage, then per item)

| model | load (2 / 4 thr) | per item, 2 threads | per item, 4 threads |
|---|---|---|---|
| NudeNet + CLIP | 0.44 / 0.47 s | 67 ms per frame | 46 ms per frame |
| YAMNet | 0.06 s | 17 ms per 11 s chunk | 17 ms per 11 s chunk |
| whisper small q5_1 | 0.33 s | 9.1 s per 30 s window | 4.5 s per 30 s window (one outlier 11.8 s) |
| Qwen3-0.6B | 0.63-0.68 s | 5.9 s first window (cold few-shot prefix), ~1.1 s warm (ledger) | 5.4 s cold |
| Qwen3-0.6B caption prompt | (same model) | 4.0 s cold | 5.1 s cold |
| Florence-2 (4 graphs) | 2.2 / 1.9 s | 5.6 s per shot | 3.5-4.7 s per shot |
| keyframe grab (ffmpeg -ss, 768x768) | | 90-160 ms per shot | |

Florence-2 per shot at 4 threads: vision encoder (DaViT at 768x768) ~2-3 s,
text encoder 0.4 s, decoder ~13 ms per token (40 tokens ~0.5 s). The shot
count, not `CAPTION_MAX_TOKENS`, is the lever on caption time.

Memory notes: Florence sessions run with the ORT CPU arena **off**
(`session_factory(arena=False)`): peak 974 MB instead of 1131 MB, resting 600 MB
instead of 1131 MB, same speed (the vision encoder needs ~0.4 GB of scratch that
the arena would otherwise keep). The merged decoder is patched in memory at
load (`signals/onnx_fix.py`, +0.25 s, ~60 MB transient).

## Keyframe extraction: per-shot seek vs. one `select` pass

| input | shots | per-shot `-ss T -i F -frames:v 1` | one pass `select='eq(n,...)'` |
|---|---|---|---|
| 60 s 640x360, GOP 2 s | 3 | 0.27 s | 0.45 s |
| 60 s 640x360, GOP 2 s | 12 | 1.06 s | 0.44 s |
| 600 s 1280x720, GOP 10 s | 3 | 0.28 s | 8.68 s |
| 600 s 1280x720, GOP 10 s | 12 | 1.96 s | 8.86 s |

The select pass decodes the whole film (scales with duration: ~105 s per 2 h
of 720p here, more for 1080p/HEVC on an i5); per-shot seeking scales with the
number of shots captioned (budgeted, <= 1500), is resumable shot by shot and
pauses cleanly. Per-shot seeking was chosen. At the full 1500-shot budget the
two are comparable (~4 min of seeking), but there the 1500 Florence runs dwarf
both.

## Projection for a 2 h film (this CPU, 4 threads)

| stage | estimate |
|---|---|
| frames | 7200 x 46 ms ~ 5.5 min + decode |
| audio | 720 chunks x 17 ms ~ 12 s + decode (~30 s) |
| speech (only without subtitles) | 258 windows x 4.5 s ~ 19 min |
| lm | <= 600 windows x ~1.1 s (typically far fewer) |
| captions | up to 1500 shots x ~4 s ~ **1.5-2 h**, + caption LM ~1 s per people shot |

Honest finding: at the planned budget (1500 shots) captions are the most
expensive stage, longer than everything else together. Lowering
`CAPTION_MAX_SHOTS` (e.g. 400: every shot any other signal flags plus an even
sample) cuts it to ~25 min; whether the captions earn their time can only be
measured on hand-marked films (`TUNING.md`).
