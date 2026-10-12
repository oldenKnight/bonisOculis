# bonis oculis analyzer (M4: subtitles + frames)

Offline scanner that reads a movie once and writes its skip file
(`spec/SKIPFILE.md`). Runs as a separate, low-priority process supervised by
Electron main (`docs/PLAN.md` §2.4). Python 3.11+, runtime deps: `numpy`,
`onnxruntime` (DirectML build on Windows), optionally `llama-cpp-python`.
ffmpeg/ffprobe are external binaries.

```
pip install -r analyzer/requirements.txt
cd analyzer && python -m bonis_analyzer scan --input movie.mkv --work /tmp/w --out movie.bonis.json
```

## Commands
| command | what it does |
|---|---|
| `scan --input F --work DIR --out F.bonis.json [--lang es-MX\|en-US] [--levels JSON] [--stages subtitles,frames] [--threads N] [--device auto\|cpu\|dml\|coreml] [--priority low\|normal] [--models DIR] [--restart] [--scores-from JSON]` | scan, checkpoint, write/merge the skip file |
| `evaluate --truth a.bonis.json --pred b.bonis.json [--tolerance 3] [--out report.json]` | per-category precision / recall / F1 (1 s resolution), range hit rate ±tolerance, seconds missed / falsely flagged; markdown table on stdout, JSON to `--out` |
| `probe --input F` | one `{"t":"probe",...}` line: duration, streams, subtitle tracks, keyframe interval, fingerprint |
| `version` | one `{"t":"version",...}` line: analyzer, Python, ORT (+providers), llama.cpp versions |

`--levels` is a JSON object `{"nudity":"strict",...}` (missing categories use the defaults:
strict for the five visual categories, `language` off), or a preset name string
(`"little-kids"`, `"teens"`). `--stages` accepts `audio,speech,captions` too; in v1 they are
reported as `skipped` ("Not available in this version").

## stdout protocol (JSON lines; logs go to stderr)
```
{"t":"stage","stage":"frames","status":"running","resumeAt":30.0}
{"t":"progress","stage":"frames","p":0.42,"eta":610}
{"t":"stage","stage":"frames","status":"done"}
{"t":"warn","msg":"No readable subtitles were found; dialogue was not checked."}
{"t":"paused"}            once when <work>/PAUSE appears
{"t":"resumed"}           when it is removed
{"t":"done","out":"/abs/path/movie.bonis.json"}
{"t":"error","code":3,"msg":"nudity model (NudeNet 320n) not found in ..."}
```
Stages in order: `subtitles` (extract + keyword/SDH lexicon), `frames` (one ffmpeg pass:
1 fps frames + scene cuts; NudeNet + CLIP), `lm` (dialogue LM over 60 s windows; runs after
frames so frame scores can trigger windows), `fusion`. Progress lines are throttled (≤ 2/s per
stage unless p moves ≥ 0.05). Exit codes: 0 ok, 2 bad input (incl. bad arguments), 3 model
missing, 4 interrupted (SIGTERM/SIGINT; resumable), 5 internal. Tracebacks only ever go to stderr.

## Work directory, resume, pause
`<work>/state.json` holds `inputFingerprint` (oshash, size, `--lang`, analyzer version, model set,
hash of `--scores-from`) and `stages: {name: {status, progress, resumeAt, ...}}`. Stage results are
per-second float32 `.npz` (`subtitles.npz`, `frames.npz` (+ `cuts`), `lm.npz`, `fusion.npz`).
The frames stage flushes its arrays every 30 media-seconds and updates `resumeAt`; a restarted scan
with the same fingerprint skips done stages and decodes from `resumeAt - 2 s` (pre-roll so a cut
at the resume point is still seen; frames before `resumeAt` are dropped). LM windows are
checkpointed every 10 windows. `--restart` or a different fingerprint wipes the work dir (only
files the analyzer owns; a non-empty directory that is not a bonis work dir is refused, exit 2).
After `done` the work dir holds only `state.json`, the stage `.npz` files and `thumbs/`.

Pause: the analyzer polls `<work>/PAUSE` once per second (frames and LM loops). While it exists
the decode pipe is not read, so ffmpeg blocks; the frames checkpoint is flushed on pause.
Priority: `os.nice(10)` (POSIX) / `BELOW_NORMAL_PRIORITY_CLASS` (Windows) unless
`--priority normal`; ffmpeg children inherit it.

No frame or audio chunk ever touches disk: frames come through `pipe:1`, subtitles are converted
to SRT on ffmpeg's stdout, thumbnails are blurred inside ffmpeg (`scale=160:-2,boxblur=10:1`) and
written as `<work>/thumbs/<rangeId>.jpg`. A transcript of the chosen subtitle track
(`subtitles.cues.json`) exists only while the scan runs (the LM stage needs it after frames).

## Signals and fusion (all constants in `bonis_analyzer/config.py`)
- **Subtitles**: embedded text tracks (ffprobe; `--lang` first, SDH/non-forced preferred) or
  sidecars `<basename>.srt/.vtt/.ass/.ssa` and `<basename>.<tag>.<ext>`; own SRT parser (BOM,
  CRLF, missing blank lines/indices, overlaps, tags). Lexicons are shared JSON in
  `spec/lexicon/{en,es}.json`; matching rules are normative in `spec/lexicon/README.md` and the
  browser extension asserts the same numbers (`spec/fixtures/subtitles/expected/*.scores.json`).
- **LM**: Qwen3-0.6B Q4 via llama.cpp, 60 s windows / 15 s stride, few-shot ChatML prompt asking
  for JSON only, answer prefilled with its first key, temperature 0. Windows run when the keyword
  pre-filter or a neighbouring frame score (> 0.2) is non-zero, plus always the top 20 windows by
  keyword score; hard budget 600. Each window's score covers its central 15 s; the subtitle signal
  is `max(keywords, 0.85 * lm)`.
- **Frames**: NudeNet 320n (letterbox to 320, YOLOv8 decoding + numpy NMS; exposed genitalia /
  anus 1.0, breast 0.9, buttocks 0.8, covered genitalia 0.25 → nudity) and CLIP ViT-B/32 int8
  (224 centre crop; cosine vs `models/clip_prompts.npz`; softmax over all prompts incl. 28 safe
  counter-prompts, summed per group → sex / kissing / implied / gore).
- **Fusion** (`fuse(signals, cuts, duration, levels, lang)`): noisy-OR of weighted signals per
  second; threshold by level (light 0.8 / moderate 0.6 / strict 0.4); runs closer than 3 s merge;
  snap outward to the nearest cut at/before the start and at/after the end when within 20 s;
  lead-in 2 s, tail 1 s; minimum 1.5 s; confidence = max score; intensity from bands (≥0.85 → 3,
  ≥0.65 → 2) +1 when two signals agree (peak ≥ 0.3); template note (`notes.py`, en/es);
  deterministic ids. The skip file is then normalised, merged with an existing file
  (locked/reviewed/manual ranges survive) and written atomically (tmp + rename). A corrupt
  existing file is moved aside to `<out>.corrupt-<epoch>`.

## Models
Directory: `--models`, else `$BONIS_MODELS_DIR`, else the bundle's `models/`, else
`analyzer/models/`. File names as in `models/manifest.json`; NudeNet is read from `320n.onnx` /
`nudenet-320n.onnx` or, if not extracted, from the sdist tarball (in memory). `clip_prompts.npz`
is committed here and rebuilt with `tools/make-clip-prompts.py` (needs `tokenizers`; the CLIP
text encoder is build-only). ORT session options: `intra_op_num_threads = --threads`,
`enable_mem_pattern = False`, sequential. `--device auto` picks DirectML (Windows) / CoreML (macOS)
when present; any unavailable or failing accelerator falls back to CPU with a `warn` line.
Packaging (PyInstaller onedir) must ship `spec/lexicon/*.json` as `<bundle>/lexicon/` and
`analyzer/models/clip_prompts.npz` under `<bundle>/models/`.

## Test hooks
| hook | effect |
|---|---|
| `--scores-from scores.json` | `{"signals": {signal: {category: [per-second] or {"segments": [[start, end, score], ...]}}}, "cuts": [s, ...]}` replaces model signals (frames, subtitles, audio, ...); no model is loaded, ffmpeg still decodes (cuts, checkpoints). A bare `{signal: {...}}` object also works. |
| `BONIS_TEST_FRAME_DELAY=0.04` | sleep per frame (only together with `--scores-from`): a slow decoder for kill/resume/pause tests |
| `BONIS_NO_HWACCEL=1` | skip the `-hwaccel auto` attempt |
| `BONIS_MODELS_DIR`, `BONIS_LEXICON_DIR`, `BONIS_FFMPEG`, `BONIS_FFPROBE`, `BONIS_LOG` | locations / log level |
| `BONIS_REGEN_FIXTURES=1` | regenerate `spec/fixtures/subtitles/expected/*.scores.json` from the Python scorer |

## Tests
```
python3 -m unittest discover -s analyzer/tests                                  # ~25 s
BONIS_MODELS_DIR=/path/to/models python3 -m unittest discover -s analyzer/tests  # + real-model smoke tests
```
All inputs are synthetic: ffmpeg `testsrc2`/`color`/noise videos, hand-written subtitle fixtures,
fed score streams. Real models run once each on random noise (shapes and code path only).

## Deviations from docs/PLAN.md §4 (to be logged by the planner)
- `language` ranges keep cue timing (no shot snapping, 0.5 s lead-in/tail, 1 s merge gap): they
  are muted, and shot-snapping a swear word would mute whole scenes of dialogue.
- The LM uses a hand-built ChatML few-shot prompt with the JSON answer prefilled instead of
  grammar-constrained chat completion: ~1.1 s per window instead of ~26 s on CPU (llama.cpp
  grammar sampling over Qwen's 151k vocabulary). It still answers JSON only, at temperature 0.
- The LM runs as its own stage after frames (protocol stage `lm`) so frame scores can trigger
  windows; in the skip file it is folded into `scan.stages.subtitles` (model + seconds).
- The frames stage keeps NudeNet and CLIP loaded together (one decode pass feeds both; ~240 MB
  peak RSS); "one model at a time" holds between stages (LM peak ~0.95 GB RSS incl. mmapped weights).
- No `pysubs2`/`pillow`: own SRT parser, ffmpeg converts everything else to SRT; thumbnails are
  JPEGs written by ffmpeg.
- Extra protocol details: `{"t":"resumed"}`, `resumeAt` on the frames `running` line,
  `{"t":"probe"}` / `{"t":"version"}` lines for those commands.
- A scan is `complete` only when frames ran (subtitles done or skipped); a subtitles-only scan is
  `partial` (kid mode will refuse it, by design).

## Known limits (honest)
- Qwen3-0.6B is weak: on synthetic SDH-only windows like `[moaning]` it often answers 0; the
  keyword/SDH lexicon carries the dialogue signal. CLIP zero-shot and the fusion weights are
  untuned: accuracy can only be measured on the owner's hand-marked files (`evaluate`).
- Picture-based subtitles (PGS/VobSub) cannot be read (no OCR); the scan warns.
