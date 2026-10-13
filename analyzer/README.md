# bonis oculis analyzer (M7: subtitles, frames, audio, speech, captions)

Offline scanner that reads a movie once and writes its skip file
(`spec/SKIPFILE.md`). Runs as a separate, low-priority process supervised by
Electron main (`docs/PLAN.md` §2.4). Python 3.11+, runtime deps: `numpy`,
`onnxruntime` (DirectML build on Windows), optionally `llama-cpp-python`
(dialogue + caption LM) and `pywhispercpp` (speech-to-text). ffmpeg/ffprobe are
external binaries. Weights and thresholds: `TUNING.md`; timings and memory:
`BENCH.md`.

```
pip install -r analyzer/requirements.txt
cd analyzer && python -m bonis_analyzer scan --input movie.mkv --work /tmp/w --out movie.bonis.json
```

## Commands
| command | what it does |
|---|---|
| `scan --input F --work DIR --out F.bonis.json [--lang es-MX\|en-US] [--levels JSON] [--stages subtitles,frames,audio,speech,captions] [--threads N] [--device auto\|cpu\|dml\|coreml] [--priority low\|normal] [--models DIR] [--restart] [--force-speech] [--whisper-cli EXE] [--profile] [--scores-from JSON]` | scan, checkpoint, write/merge the skip file |
| `evaluate --truth a.bonis.json --pred b.bonis.json [--tolerance 3] [--out report.json]` | per-category precision / recall / F1 (1 s resolution), range hit rate ±tolerance, seconds missed / falsely flagged; markdown table on stdout, JSON to `--out` |
| `probe --input F` | one `{"t":"probe",...}` line: duration, streams, subtitle tracks, keyframe interval, fingerprint |
| `version [--cpu-features]` | one `{"t":"version",...}` line: analyzer, Python, ORT (+providers), llama.cpp versions; `--cpu-features` adds `"cpu": {arch, avx2, flags, source, ggmlStages: ok\|skipped, skippedStages}` (llama.cpp is not imported when AVX2 is missing) |

`--levels` is a JSON object `{"nudity":"strict",...}` (missing categories use the defaults:
strict for the five visual categories, `language` off), or a preset name string
(`"little-kids"`, `"teens"`). `--stages` defaults to all five. `--lang` (default es-MX) picks
the lexicon and note language; when it is given it is also the speech-to-text language,
otherwise whisper auto-detects. `--force-speech` runs speech-to-text even when subtitles exist.
`--whisper-cli` names a whisper.cpp executable used when the Python binding is missing.
`--profile` adds a final `{"t":"profile"}` line (below).

## stdout protocol (JSON lines; logs go to stderr)
```
{"t":"stage","stage":"frames","status":"running","resumeAt":30.0}
{"t":"progress","stage":"frames","p":0.42,"eta":610}
{"t":"stage","stage":"frames","status":"done"}
{"t":"warn","msg":"No readable subtitles were found; dialogue was not checked."}
{"t":"warn","code":"cpu-no-avx2","stage":"lm","msg":"This computer's processor is too old for the dialogue model (no AVX2); ..."}
{"t":"paused"}            once when <work>/PAUSE appears
{"t":"resumed"}           when it is removed
{"t":"done","out":"/abs/path/movie.bonis.json"}
{"t":"error","code":3,"msg":"nudity model (nsfw-vit-int8.onnx) not found in ..."}
{"t":"profile","stages":{"frames":{"wall":3.5,"peakRssMB":317.5},...},"peakRssMB":986.1,
 "framesProcessed":60,"shotsCaptioned":3,"windowsScored":{"lm":1,"speech":3,"audioChunks":7,"captionLm":0}}
                          (--profile only, after "done")
```
Stages in order: `subtitles` (extract + keyword/SDH lexicon), `speech` (only when no subtitles
were read, or `--force-speech`), `frames` (one ffmpeg pass: 1 fps frames + scene cuts; nsfw
classifier + CLIP), `audio` (YAMNet sound events), `lm` (dialogue LM over 60 s windows of the subtitle cues,
or of the speech cues when there were no subtitles; runs after frames so frame scores can
trigger windows), `captions` (Florence-2 per shot, then the caption LM), `fusion`. Exactly one
model set is loaded at a time (`models.model_set` registry; every stage releases its models,
`gc` + `malloc_trim`, before the next loads). A missing optional model (YAMNet, whisper,
Florence-2, the LM) skips that stage with a `warn`; only the frames models are mandatory (exit 3).
CPU guard (`cpu.py`): llama.cpp and whisper.cpp are built for AVX2 on x86 and would die with an
illegal instruction on an older CPU, so without AVX2 the `speech` and `lm` stages (and the caption
LM) are skipped with a `{"t":"warn","code":"cpu-no-avx2","stage":...}` line and a `detail` on the
stage; subtitles, frames, audio and captions still run (ONNX Runtime picks its own kernels).
Detection: Linux `/proc/cpuinfo` flags, macOS `sysctl -n machdep.cpu.leaf7_features` (arm64 always
supported), Windows `IsProcessorFeaturePresent(40)`; unknown counts as supported;
`BONIS_CPU_AVX2=0|1` overrides. Progress lines are throttled (≤ 2/s per
stage unless p moves ≥ 0.05). Exit codes: 0 ok, 2 bad input (incl. bad arguments), 3 model
missing, 4 interrupted (SIGTERM/SIGINT; resumable), 5 internal. Tracebacks only ever go to stderr.

## Work directory, resume, pause
`<work>/state.json` holds `inputFingerprint` (oshash, size, `--lang`, analyzer version, model set,
hash of `--scores-from`, `--force-speech`) and `stages: {name: {status, progress, resumeAt, ...}}`. Stage results are
per-second float32 `.npz` (`subtitles.npz`, `speech.npz`, `frames.npz` (+ `cuts`), `audio.npz`,
`lm.npz` (+ `source`), `captions.npz` (+ per-shot `shot_start`, `shot_end`, `shot_scores`,
`captioned`; scores only, never caption text), `fusion.npz`).
The frames stage flushes its arrays every 30 media-seconds and updates `resumeAt`; a restarted scan
with the same fingerprint skips done stages and decodes from `resumeAt - 2 s` (pre-roll so a cut
at the resume point is still seen; frames before `resumeAt` are dropped). LM windows are
checkpointed every 10 windows. The audio stage flushes `audio.npz` + `resumeAt` every 6 chunks
(60 s) and resumes at that chunk boundary with its 1 s overlap; speech checkpoints every 30 s
window (`speech.windows.json`, deleted at the end); captions checkpoint every 10 shots
(`captions.partial.npz`: per-shot scores and flags, no text; a resumed scan re-captions shots
whose caption mentioned people but had not yet been rated by the LM, because their text was
never stored). `--restart` or a different fingerprint wipes the work dir (only
files the analyzer owns; a non-empty directory that is not a bonis work dir is refused, exit 2).
After `done` the work dir holds only `state.json`, the stage `.npz` files and `thumbs/`.

Pause: the analyzer polls `<work>/PAUSE` once per second (frames, audio, speech, LM and caption
loops; a speech window or caption already started finishes first). While it exists
the decode pipe is not read, so ffmpeg blocks; the frames checkpoint is flushed on pause.
Priority: `os.nice(10)` (POSIX) / `BELOW_NORMAL_PRIORITY_CLASS` (Windows) unless
`--priority normal`; ffmpeg children inherit it.

No frame or audio chunk ever touches disk: frames come through `pipe:1`; audio is a second ffmpeg
pass `-vn -ac 1 -ar 16000 -f f32le pipe:1` read 10 s (audio) or 30 s (speech) at a time and fed
to the models as float32 arrays; caption keyframes are a third pass that seeks to each chosen
shot (`-ss T -i F -frames:v 1 -vf scale=768:768 -f rawvideo pipe:1`, see `BENCH.md` for why
not one `select` pass); subtitles are converted to SRT on ffmpeg's stdout; thumbnails are blurred
inside ffmpeg (`scale=160:-2,boxblur=10:1`) and written as `<work>/thumbs/<rangeId>.jpg`. The
only temporary media file is the whisper-cli fallback's per-window WAV, deleted in `finally`.
Transcripts of the subtitle track / speech (`subtitles.cues.json`, `speech.cues.json`) exist only
while the scan runs (the LM stage needs them after frames). Caption text exists only in memory.
stdout is moved to a private file descriptor at scan start (fd 1 then points at stderr), so a
native library that prints cannot corrupt the protocol.

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
- **Frames**: the AdamCodd/vit-base-nsfw-detector classifier (ViT-B/16, int8 ONNX, Apache-2.0;
  plain resize to 384 x 384, mean/std 0.5 as its `preprocessor_config.json` says, which is read
  at load together with `id2label` from its `config.json`; batches of 8; softmax nsfw
  probability) and CLIP ViT-B/32 int8 (224 centre crop; cosine vs `models/clip_prompts.npz`;
  softmax over all prompts incl. 31 safe counter-prompts, summed per group → sex / kissing /
  implied / gore / nudity). Frame nudity = `max(classifier, 0.8 x CLIP nudity group)`
  (`CLIP_NUDITY_WEIGHT`, `TUNING.md`). NudeNet was dropped (licence ambiguity, ledger D22):
  no body-part granularity any more.
- **Audio** (`signals/audio.py`): YAMNet ONNX (`waveform` float32 [N] at 16 kHz -> [frames, 521],
  0.96 s frames, 0.48 s hop) over 10 s chunks with the previous chunk's last 1 s prepended.
  `config.AUDIO_CLASS_MAP` maps AudioSet classes (names checked against the committed official
  `models/yamnet_class_map.csv`, Apache-2.0, sha256 in config.py) to sex / implied / gore with
  weights; per second = max over overlapping frames. Screaming alone can never flag gore
  (`TUNING.md`).
- **Speech** (`signals/speech.py`): whisper.cpp small q5_1 through `pywhispercpp` on float32 PCM
  (nothing on disk), 30 s windows with 2 s overlap, each cue owned by exactly one window; falls
  back to a `whisper-cli` executable (temp WAV in the work dir, deleted in `finally`). The cues go
  through the subtitle scorer (lexicon now, the dialogue LM later): speech has no lexicon of its
  own and becomes the `speech` signal.
- **Captions** (`signals/captions.py`): Florence-2 base-ft q4f16 via ONNX Runtime with a
  hand-written greedy loop (vision encoder -> embed_tokens + `<MORE_DETAILED_CAPTION>` prompt ->
  encoder -> merged decoder with self-attention cache; forced BOS, no-repeat-3-gram, <= 40 new
  tokens). Prompt and special ids are precomputed at build time (`tools/make-florence-prompts.py`
  -> `models/florence_prompts.json`, committed); ids are decoded with a ~60-line byte-level BPE
  decoder over `florence2-tokenizer.json` (no `tokenizers`/`transformers` at runtime). One keyframe
  per shot (shots = scene cuts, split above 20 s; 10 s steps when no frames stage ran); budget
  1500 shots (every shot where another signal reaches 0.2, plus an even sample of the rest).
  Caption -> English lexicon; captions mentioning people -> the LM with a caption prompt
  (sex/implied/kissing/gore) in one batch after Florence is released. Shot score =
  `max(lexicon, 0.85 * LM)`. Scores only, never text, reach `captions.npz`; notes stay templates.
  The q4f16 merged decoder as published is rejected by ONNX Runtime >= 1.2x ("Subgraph output
  (logits) is an outer scope value being returned directly"): `signals/onnx_fix.py` repairs the
  graph in memory at load (pure-Python protobuf edit, no `onnx` package; the file on disk keeps its
  manifest sha256).
- **Fusion** (`fuse(signals, cuts, duration, levels, lang)`): noisy-OR of weighted signals per
  second (`SIGNAL_WEIGHTS`, five signals), plus an agreement bonus where two signals from
  different groups (picture, description, dialogue, sound) both reach 0.3
  (`p' = 1 - (1 - p) * 0.75`); threshold by level (light 0.8 / moderate 0.6 / strict 0.4); runs
  closer than 3 s merge; snap outward to the nearest cut at/before the start and at/after the end
  when within 20 s; lead-in 2 s, tail 1 s; per-category minimum duration (nudity 1.5, sex 3,
  implied 3, kissing 2, gore 1.5, language 1 s; short ranges are extended, never dropped);
  confidence = max score; intensity from bands (≥0.85 → 3, ≥0.65 → 2) +1 when two signals agree
  (peak ≥ 0.3); template note (`notes.py`, en/es); deterministic ids. `fusion.assemble_signals`
  is the one place that turns stage arrays into signals (used by the scan and `tools/tune.py`). The skip file is then normalised, merged with an existing file
  (locked/reviewed/manual ranges survive) and written atomically (tmp + rename). A corrupt
  existing file is moved aside to `<out>.corrupt-<epoch>`.

## Models
Directory: `--models`, else `$BONIS_MODELS_DIR`, else the bundle's `models/`, else
`analyzer/models/`. File names as in `models/manifest.json` (nudity: `nsfw-vit-int8.onnx` +
`nsfw-vit-config.json` + `nsfw-vit-preprocessor_config.json`). `clip_prompts.npz`
is committed here and rebuilt with `tools/make-clip-prompts.py` (needs `tokenizers`; the CLIP
text encoder is build-only). ORT session options: `intra_op_num_threads = --threads`,
`enable_mem_pattern = False`, sequential. `--device auto` picks DirectML (Windows) / CoreML (macOS)
when present; any unavailable or failing accelerator falls back to CPU with a `warn` line.
Packaging (PyInstaller onedir) must ship `spec/lexicon/*.json` as `<bundle>/lexicon/` and
`analyzer/models/clip_prompts.npz`, `yamnet_class_map.csv` and `florence_prompts.json` under
`<bundle>/models/`. Florence-2 sessions run with the ORT CPU memory arena off (peak 974 MB
instead of 1131 MB, see `BENCH.md`).

## Test hooks
| hook | effect |
|---|---|
| `--scores-from scores.json` | `{"signals": {signal: {category: [per-second] or {"segments": [[start, end, score], ...]}}}, "cuts": [s, ...]}` replaces model signals (frames, subtitles, audio, ...); no model is loaded, ffmpeg still decodes (cuts, checkpoints). A bare `{signal: {...}}` object also works. |
| `--scores-from` extra keys | `"framesParts": {"nsfw": [per-second] or {segments}, "clipNudity": ...}` (the two nudity inputs of the frames scorer; the scan fuses them with `fuse_nudity` exactly as the real scorer, max()ed with a fed `frames.nudity`), `"audioClasses": {"Wail, moan": [per-second] or {segments}}` (fed YAMNet class scores: decode, chunking, class mapping and checkpoints run, no model), `"transcript": [[start, end, text], ...]` (what the fake speech engine hears), `"captionsText": [[start, end, caption], ...]` (fake scene descriptions by media time; keyframes are still extracted) |
| `Scan(args, proto, lm_factory=, audio_factory=, stt_factory=, captioner_factory=)` | in-process tests: stand-ins (`FakeLM`, `FedAudioScorer`, `FakeSTT`, `FakeCaptioner`) |
| `BONIS_TEST_FRAME_DELAY=0.04` | sleep per frame (only together with `--scores-from`): a slow decoder for kill/resume/pause tests |
| `BONIS_TEST_UNIT_DELAY=0.5` | sleep per audio chunk / speech window / caption shot (only with `--scores-from`) |
| `BONIS_WHISPER_CLI` | whisper.cpp executable for the fallback speech engine (also `--whisper-cli`) |
| `BONIS_NO_HWACCEL=1` | skip the `-hwaccel auto` attempt |
| `BONIS_CPU_AVX2=0\|1` | force the CPU guard's answer (0 = behave as on a CPU without AVX2); tests patch `cpu.has_avx2` instead |
| `BONIS_MODELS_DIR`, `BONIS_LEXICON_DIR`, `BONIS_FFMPEG`, `BONIS_FFPROBE`, `BONIS_LOG` | locations / log level |
| `BONIS_REGEN_FIXTURES=1` | regenerate `spec/fixtures/subtitles/expected/*.scores.json` from the Python scorer |

## Tests
```
python3 -m unittest discover -s analyzer/tests                                  # 189 tests, ~50 s
BONIS_MODELS_DIR=/path/to/models python3 -m unittest discover -s analyzer/tests  # + real-model tests, ~4-5 min
```
All inputs are synthetic: ffmpeg `testsrc2`/`color`/sine/silence/noise clips, hand-written subtitle
fixtures, fed score streams, fed class scores / transcripts / captions. Real models run a handful
of times: the nsfw classifier + CLIP once on noise, YAMNet once on 2 s of sine, whisper once on 5 s of
silence + sine, Florence-2 once on one noise frame and three times on the 60 s testsrc2 clip
(memory budget: captions stage < 1.2 GB), Qwen3 once per prompt type, plus one full real scan of
a 4 s noise clip.

Tools: `tools/make-florence-prompts.py` (build time, needs `tokenizers`: Florence prompt/special
ids -> `models/florence_prompts.json`), `tools/tune.py` (grid search of fusion weights and
thresholds against hand-marked films, see `TUNING.md`).

## Deviations from docs/PLAN.md §4 (to be logged by the planner)
- `language` ranges keep cue timing (no shot snapping, 0.5 s lead-in/tail, 1 s merge gap): they
  are muted, and shot-snapping a swear word would mute whole scenes of dialogue.
- The LM uses a hand-built ChatML few-shot prompt with the JSON answer prefilled instead of
  grammar-constrained chat completion: ~1.1 s per window instead of ~26 s on CPU (llama.cpp
  grammar sampling over Qwen's 151k vocabulary). It still answers JSON only, at temperature 0.
- The LM runs as its own stage after frames (protocol stage `lm`) so frame scores can trigger
  windows; in the skip file it is folded into `scan.stages.subtitles` (model + seconds).
- The frames stage keeps the nsfw classifier and CLIP loaded together (one decode pass feeds
  both; ~480 MB peak RSS); "one model at a time" holds between stages (LM peak ~0.95 GB RSS incl. mmapped weights).
- No `pysubs2`/`pillow`: own SRT parser, ffmpeg converts everything else to SRT; thumbnails are
  JPEGs written by ffmpeg.
- Extra protocol details: `{"t":"resumed"}`, `resumeAt` on the frames/audio `running` lines,
  `{"t":"probe"}` / `{"t":"version"}` lines for those commands, `{"t":"profile"}` with `--profile`.

M7 (analyzer v2):
- PLAN §4 "One decode pass design" / ledger D7 "One decode pass per movie yields sampled frames,
  scene-cut scores and audio via pipes": audio is its own ffmpeg pass (and a second one when
  speech runs), and caption keyframes a third, seeking pass. Sharing one pass would keep YAMNet,
  whisper and the vision models loaded together, against "one model loaded at a time"; audio
  decoding costs seconds. Still pipes only.
- PLAN §4 "audio pass → s16le 16 kHz mono pipe": `f32le` (what YAMNet and whisper consume).
- PLAN §4 "speech.py whisper-cli sidecar (small q5) → srt → subtitles scorer" and "whisper gets
  a temp wav that is deleted in `finally`": whisper.cpp runs in-process through `pywhispercpp`
  on PCM arrays (no file at all) and returns cues directly; the whisper-cli sidecar with a temp
  WAV deleted in `finally` is the fallback.
- PLAN §4 "captions.py Florence-2 base (ORT) ... → LM scorer → implied/sex/gore": captions are
  also scored by the English lexicon; only captions that mention people go to the LM; the LM
  rates sex/implied/kissing/gore. Greedy decoding instead of the model's default 3-beam search
  (3x cheaper; forced BOS and no-repeat-3-gram kept). Shots longer than 20 s are split.
- The published Florence-2 q4f16 merged decoder does not load in ONNX Runtime 1.29; it is
  repaired in memory at load time (`signals/onnx_fix.py`).
- Missing YAMNet / whisper / Florence-2 skips that stage with a warning (like the LM in v1);
  only missing frames models stop the scan (exit 3). `scan.status` is `complete` when frames ran
  and every requested stage is done or skipped.
- `--lang` no longer defaults inside argparse (still es-MX for lexicon and notes) so speech can
  auto-detect the film's language when the app does not pass it; `--stages` defaults to all five.
- When the dialogue came from speech-to-text, the LM is folded into `scan.stages.speech`.
- Agreement bonus groups: frames and captions count as two independent groups (different
  models, same pixels); subtitles and speech as one.
- A scan is `complete` only when frames ran (subtitles done or skipped); a subtitles-only scan is
  `partial` (kid mode will refuse it, by design).

## Known limits (honest)
- Qwen3-0.6B is weak: on synthetic SDH-only windows like `[moaning]` it often answers 0; the
  keyword/SDH lexicon carries the dialogue signal. CLIP zero-shot and the fusion weights are
  untuned: accuracy can only be measured on the owner's hand-marked files (`evaluate`,
  `tools/tune.py`). None of the v2 weights (audio classes, captions, agreement) has seen a real film.
- Captions are the most expensive stage: ~3.5-5.6 s per shot on this 4-vCPU CPU, so a film at
  the 1500-shot budget needs 1.5-2 h for captions alone (`BENCH.md`).
- Whisper on a pure tone writes "(BEEPING)" / "[SILENCIO]"-style tokens; on real films it can
  hallucinate short phrases over music. Only lexicon hits matter, so this is mostly harmless.
- The whisper-cli fallback is implemented and unit-tested with a fake executable only; no real
  whisper-cli binary was available here.
- Picture-based subtitles (PGS/VobSub) cannot be read (no OCR); the scan warns.
- The nsfw classifier is ~4x slower than NudeNet was (287 vs 67 ms per frame at 2 threads,
  `BENCH.md`) and is a whole-image sfw/nsfw call: expect more false alarms on swimwear /
  shirtless / medical scenes and misses on small figures until tuned on hand-marked films.
- The AVX2 guard was tested with the detection patched both ways; no pre-AVX2 machine was
  available to confirm that the wheels really crash there or that ONNX Runtime keeps working.
