# bonis oculis — Architecture and UX plan (v1)

Author: Fable 5.1 (planner). Implementers: Opus subagents. Visual design: Sonnet (docs/DESIGN.md).
This plan is binding for implementers. Deviations go through the planner and are logged in LEDGER.md.

## 0. Principles
1. Detect never, obey always: no detection at playback. The skip file is the contract.
2. Fail closed for kids, fail soft for parents. Kid mode never plays unprotected.
3. No scene ever reaches a screen or disk unblurred through this app.
4. The app is three processes: Electron (UI + supervisor), mpv (playback), analyzer (Python).
   Any one may die; the other two survive and recover.
5. Everything is resumable: scans checkpoint per stage and per timestamp; marks autosave on every
   change; the player remembers position.
6. Nothing leaves the computer. There is no code path that opens a network socket, except the
   optional LAN share (off by default, explicit toggle, local subnet only).
7. JavaScript is ES5, vanilla, one concern per file, IIFE globals under `BO.*` in the renderer and
   CommonJS modules in main. No bundler, no framework, no transpiler.

## 1. Repository layout
```
package.json             electron app root; scripts: start, test, lint, dist
desktop/
  main/                  Electron main (Node): main.js, window.js, ipc.js, store.js, pin.js,
                         library.js, fingerprint.js, scanner-supervisor.js, player-controller.js,
                         exporters/{json,edl,mpv-edl,clean-copy}.js, i18n.js, log.js
  preload.js             contextBridge: window.bo.invoke(channel, payload) only
  renderer/
    index.html           single page, views toggled by BO.router
    css/                 tokens.css (design system), base.css, components/*.css, views/*.css
    js/                  core.js (BO namespace, util), i18n.js, router.js, store.js,
                         views/{setup,library,kid,review,settings,export,help,player}.js,
                         components/{timeline,thumb,modal,toast,pin-pad,level-picker}.js
    assets/              logo.svg, icons/*.svg, fonts/ (bundled, no CDN)
  locales/               en-US.json, es-MX.json (flat keys, ICU-free, {placeholders})
player/
  bonis.lua              mpv script: reads skip JSON, enforces ranges, marks, panic, autosave
  README.md              keys, IPC messages
analyzer/
  bonis_analyzer/        Python 3.11 package (see §4)
  tests/                 synthetic fixtures only
  requirements.txt       onnxruntime(-directml on win), numpy, llama-cpp-python, pysubs2, pillow
  models/manifest.json   model names, urls, sha256, licence, size
spec/
  skipfile.schema.json   source of truth
  SKIPFILE.md
  fixtures/              valid/*.bonis.json, invalid/*.json, srt/, vtt/, scores/
shared/
  skipfile.js            ES5 CommonJS+IIFE dual: validate, normalise, merge, summary, EDL export
                         (used by main, renderer and extension; no dependencies)
extension/               MV3 (M6)
tools/                   fetch-binaries.js, fetch-models.js, make-fixtures.js, eval.py
docs/                    BRIEF, LEDGER, PLAN, DESIGN, HELP (in-app help source, en/es)
```

## 2. Processes and contracts

### 2.1 Electron main ↔ renderer
`ipcMain.handle(channel)` only; channels are a closed list in `desktop/main/ipc.js`. Renderer has
no Node access (contextIsolation on, sandbox on, nodeIntegration off). CSP: `default-src 'self'`.
Channels (v1): `library:list/add/remove`, `scan:queue/pause/resume/cancel/status`,
`skip:get/save/approve/reject/edit/add/delete`, `player:play/stop/status`, `pin:set/verify/lock`,
`settings:get/set`, `export:json/edl/clean`, `import:json`, `help:open`, `app:version`.
Events main → renderer (`webContents.send`): `scan:progress`, `player:event`, `library:changed`,
`toast`.

### 2.2 Electron main ↔ mpv
Main spawns the bundled mpv with:
`--input-ipc-server=<pipe> --script=player/bonis.lua --script-opts=bonis-skipfile=<path>,bonis-marks=<path>,bonis-kidmode=0|1,bonis-lang=es|en --hwdec=auto-safe --keep-open=yes --force-window=yes --osd-level=1 --no-config --save-position-on-quit --title="bonis oculis"`
IPC is JSON lines over the pipe. Main observes `time-pos`, `pause`, `path`, `eof-reached`.
Lua → app messages use `mp.commandv("script-message", "bonis", json)` which main receives as
`client-message` events: `{t:"mark", range}`, `{t:"panic", phase:"start"|"end", at}`,
`{t:"skipped", rangeId}`, `{t:"ready", ranges:n}`, `{t:"error", msg}`.
App → Lua: `script-message-to bonis reload <path>` and `script-message-to bonis set-kidmode 0|1`.
If mpv exits with non-zero while playing, main relaunches once at the last known position and
shows a toast; a second crash within 60 s stops and shows the recovery dialog.

### 2.3 Lua script behaviour (player/bonis.lua)
- Parses the JSON with `mp.utils.parse_json`; validates `format`/`version`; sorts ranges; keeps
  only enforced ones (`review != rejected`, `action != none`). Applies `media.offset`.
- Enforcement on every `time-pos` change (observe_property) AND after every seek
  (`on seek`/`playback-restart`): if `t >= start - 0.05 and t < end` for a `skip` range → `seek end absolute+exact`, show OSD "Scene skipped" (localised) for 1.5 s. Seeks landing inside a
  range jump to its end. Backward seeks into a range are clamped to `start - 1`.
- `hide`: full-frame black `osd-overlay` (ASS) + `mute=yes`; restored at `end`.
- `blur`: `vf add @bo-blur:lavfi=[scale=iw/24:-2:flags=area,scale=iw*24:-2:flags=neighbor]`
  + mute. If `frame-drop-count` grows by > 5 within the range, remove the filter and switch to
  hide for the rest of the range (remember per session). Requires `hwdec=auto-copy`; the app
  passes `--hwdec=auto-copy` only when the file contains blur ranges.
- `mute`: `mute=yes` for the range.
- Marking: `i` mark in, `o` mark out (creates range, category `other`, source `manual`,
  review `pending`, action `skip`), `u` undo last mark. OSD shows "Mark set at 01:23:45".
- Panic: `p` (also `Ctrl+Space`). Phase 1: black overlay + mute + start a panic mark, seek
  forward in 10 s steps on every further `p`? No: phase 1 hides; phase 2 (`p` again or `Enter`)
  ends the hide, writes the panic range `[start - 2, now]`, source `panic`, review `approved`,
  action `skip`, category `other`. While hidden, `→` seeks +10 s silently.
- Autosave: every mark and panic is appended to `bonis-marks` JSON lines file immediately
  (the app merges it into the skip file). If the app is gone, nothing is lost.
- Kid mode: `bonis-kidmode=1` disables marking keys, disables seeking into ranges, hides OSD
  details, and if the skip file failed to load → `quit` with error code 3 (app shows the parent).

### 2.4 Electron main ↔ analyzer
Spawn `analyzer` executable (PyInstaller onedir) with:
`scan --input <video> --work <dir> --out <skip.json> --lang es-MX --levels '{...}' --stages subtitles,frames,audio,speech,captions --threads N --priority low --device auto`
stdout = JSON lines: `{"t":"progress","stage":"frames","p":0.42,"eta":610}`, `{"t":"stage","stage":"frames","status":"done"}`, `{"t":"warn","msg":...}`, `{"t":"done","out":path}`,
`{"t":"error","code":..., "msg":...}`. stderr = log. Exit codes: 0 ok, 2 bad input, 3 model
missing, 4 interrupted (resumable), 5 internal.
Supervisor rules: one scan at a time; paused (SIGSTOP / NtSuspendProcess via `--pause-file`
polling, simpler: the analyzer polls `<work>/PAUSE` every second) while mpv runs; low OS priority;
"only when plugged in" default on laptops (Electron `powerMonitor.isOnBatteryPower`); on crash,
restart up to 3 times from the checkpoint; after that mark the title "Needs attention".

## 3. Skip file
See spec/SKIPFILE.md. `shared/skipfile.js` is the single JS implementation: `validate(doc)` →
`{ok, errors[]}` (hand-written validator, no ajv, ES5), `normalise(doc)` (sort, clamp, derive
summary, drop overlaps by keeping higher confidence), `merge(oldDoc, newScanDoc)` (keep locked and
reviewed ranges; replace auto pending ranges), `toKodiEdl(doc)`, `toMpvEdl(doc, path)`,
`applyOffset(doc, seconds)`, `enforced(doc)`.

## 4. Analyzer (Python)
Package `bonis_analyzer`. Entry `cli.py`. One decode pass design.
```
pipeline/
  probe.py       ffprobe → duration, streams, subtitle tracks, keyframe interval
  decode.py      ffmpeg → rawvideo pipe (fps=1, 320px wide, rgb24) + scene scores (showinfo on
                 a split branch, stderr) ; audio pass → s16le 16 kHz mono pipe
  checkpoint.py  <work>/state.json + per-stage .npz/.json ; resume logic
signals/
  subtitles.py   extract/parse (pysubs2), SDH cue lexicon, keyword lexicon es/en with weights,
                 LM scorer over 60 s windows (llama.cpp, Qwen3-0.6B Q4, JSON output, temp 0)
  frames.py      NudeNet 320n (ORT) + CLIP ViT-B/32 image embeddings; zero-shot via precomputed
                 prompt embeddings (models/clip_prompts.npz); per-second category scores
  audio.py       YAMNet (ORT) 0.96 s frames → class→category mapping with weights
  speech.py      whisper-cli sidecar (small q5) → srt → subtitles scorer; only when no subtitles
  captions.py    Florence-2 base (ORT) on one keyframe per shot, budgeted (max 1500 shots,
                 prioritise shots with any other signal > 0.2) → LM scorer → implied/sex/gore
fusion.py        per-shot vectors; category score = weighted noisy-OR of signals; thresholds by
                 level; expand to shot boundaries (scene cuts); merge gaps < 3 s; lead-in 2 s,
                 tail 1 s; min 1.5 s; confidence; intensity; template notes (en/es)
output.py        write skip JSON (validated against spec); merge with existing via same rules as
                 shared/skipfile.js (ported, tested on the same fixtures)
evaluate.py      truth vs prediction → per-category precision/recall at 1 s resolution + range
                 hit rate with ±3 s tolerance → JSON + markdown table
```
Memory: one model loaded at a time; explicit `del` + `gc.collect()`; ORT session options
`intra_op_num_threads = threads`, `enable_mem_pattern = False` on 4 GB machines. No temp frames on
disk: frames flow through the pipe; audio flows through the pipe; whisper gets a temp wav that is
deleted in `finally`. `<work>` holds only small JSON/npz checkpoints and blurred thumbnails
(generated at extraction with `boxblur=10:1` at 160 px; the clear frame is never written).

Device selection: ORT providers `DmlExecutionProvider` (win) / `CoreMLExecutionProvider` (mac) /
`CPUExecutionProvider`; llama.cpp `n_gpu_layers=-1` with Metal/Vulkan if available, else 0.

## 5. UX (screens) — visuals per docs/DESIGN.md
1. **First run** (3 steps, each one screen): language → create PIN (4-6 digits, confirm) →
   choose a preset (Little kids / Teens / I'll choose) → "Add your first movie" drop zone.
2. **Library** (parent): grid of posters-or-frames (first keyframe, blurred until scan says it is
   clean), status pill per title: Not scanned · Scanning 43% · 3 to review · Protected (12 scenes)
   · Needs attention. Big Play. Scan queue drawer at the bottom. Drag-and-drop anywhere.
3. **Kid mode** (locked): only Protected titles, large tiles, Play, nothing else. Lock icon →
   PIN pad.
4. **Review**: header with the parents card (counts per category, non-graphic). Timeline
   across the full width, ranges coloured by category, blurred thumbnail strip; selecting a range
   opens a side panel: category, intensity, action, note, signal bars, edge handles with ±0.5 s
   buttons, Approve / Reject / Peek (PIN re-asked after 5 min). "Approve all" with confirm.
5. **Settings** (PIN): Protection (level per category with one-sentence explanations),
   Playback (action defaults, panic key, hotkeys), Scanning (plugged-in only, pause while playing,
   threads), Privacy (one screen stating what the app never does, plus the bypass notes),
   Language, PIN, About.
6. **Export / Send to TV**: three cards: Skip file (.bonis.json), Kodi list (.edl), Clean copy
   (USB) — each with a plain explanation and a "How to play this on your TV" link.
7. **Now playing**: small panel while mpv is open: title, protected scenes count, hotkey cheat
   sheet, "Stop". Marks arriving from mpv appear live.
8. **Help**: Fire TV paths (USB + VLC primary; Kodi advanced), extension, what the app cannot do.

Tone rules: no jargon, no numbers to tune unless "Custom"; every error says what to do next;
Spanish (MX) and English (US) from day one via `locales/*.json`.

## 6. Security and privacy
- PIN: scrypt (N=2^15) with per-install salt, stored in `<userData>/secure.json`; 5 wrong tries →
  30 s cooldown doubling. Recovery: a 12-word recovery phrase shown once at setup.
- Settings and skip files carry an HMAC (key in secure.json) → tamper-evident, not tamper-proof.
  Help states that an administrator account can defeat the PIN.
- No `net`, `http`, `dns` imports anywhere in the app; a test greps for them. Electron: no
  auto-updater, no crash reporter, `app.commandLine.appendSwitch('disable-features', ...)`.
- Binaries and models are hash-verified at build time (manifest) and at first run.
- Logs never contain file names of flagged frames nor notes; log rotation 5 × 1 MB.

## 7. Packaging
electron-builder: Windows x64 NSIS (offline), macOS universal DMG. `tools/fetch-binaries.js`
downloads pinned mpv/ffmpeg/whisper-cli builds; `tools/fetch-models.js` downloads models from the
manifest with sha256. Analyzer packaged with PyInstaller onedir, no PyTorch. Unsigned builds: the
help has a first-launch page for Gatekeeper and SmartScreen; signing added when certificates exist.

## 8. Testing (synthetic only)
- `spec/fixtures` shared by JS (node test runner) and Python (pytest).
- Lua script tested with real mpv against a generated colour-bar video (ffmpeg testsrc) plus a
  fixture skip file; a harness drives mpv over IPC and asserts `time-pos` jumps.
- Analyzer tested with fed-in scores (`--scores-from fixture.json`) replacing model calls, plus
  synthetic subtitles. Model code paths tested with tiny random inputs only.
- Evaluation harness tested against synthetic truth/prediction pairs.
- Electron UI: Playwright smoke tests under xvfb (launch, setup wizard, add fixture movie, review
  fixture skip file, export EDL).

## 9. Milestones and acceptance (ties to LEDGER)
M2 spec + shared/skipfile.js + fixtures + exporters (tests green, both JS and Python readers agree)
M3 player: Lua + controller; harness proves skip/hide/mute/mark/panic/kid-mode fail-closed
M4 analyzer v1: subtitles + frames, resumable; evaluate.py; fed-score tests
M5 app shell: all screens, PIN, i18n, import/export, clean copy; Playwright smoke green
M6 extension: subtitle pre-read + import
M7 analyzer v2: audio + captions + fusion tuning
M8 extension live audio
M9 packaging + help + board review pass
