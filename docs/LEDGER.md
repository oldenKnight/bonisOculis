# bonis oculis — Progress ledger and handoff note

READ THIS FIRST on any restart. Then docs/BRIEF.md (the owner's spec). Do not re-derive context.

## Current phase
IMPLEMENTATION. On 2026-10-12 the owner granted full authority: "treat my prompt as a suggestion...
you have full authority to fulfill my needs, essential vision, and quality standards". Open
questions were decided by the planner (see "Decisions on open questions"). docs/PLAN.md is binding.
Active milestones: M1 (design, Sonnet), M2 (spec + shared lib), M3 (player). Agents run in parallel.

## Timeline
- 2026-10-12  Owner delegated full authority. M1a plan+spec, M1b design, M2 shared lib done.
              M3 player and M4 analyzer v1 running as agents.
- 2026-10-12  Session 1 (Fable 5.1). Repo was empty. Researched models/licences, mpv EDL, Fire TV,
              Tauri vs Electron, MV3 limits. Delivered critique + 8 questions to the owner.
              Owner added quality standard 5.2b (kids-protection commission; excel vs Common Sense
              Media, VidAngel extension, ClearPlay app). Wrote BRIEF.md and this ledger.

## Decisions taken so far (owner-visible, pending explicit approval where marked)
D1  Shell: Electron (kept). Tauri rejected: size win vanishes next to ~1 GB of models + mpv; on
    Windows its webview is Chromium anyway; its only offline-safe installer mode adds ~127 MB;
    Electron keeps everything in JS and renders identically on both OSes.
D2  Analyzer: bundled Python, NO PyTorch. ONNX Runtime (DirectML on Windows, CoreML on macOS, CPU
    fallback) + llama.cpp (Metal/Vulkan) + whisper.cpp. Separate supervised process with per-stage
    checkpoints; a model crash never takes the app down.
D3  Player: mpv as separate window (v1), controlled over JSON IPC. A Lua script inside mpv reads the
    native skip JSON and performs skip/hide/blur/mute, marking hotkeys and panic key itself.
    Later embedding on macOS needs the libmpv render API (not --wid); keep IPC boundary ready.
D4  mpv does NOT read Kodi .edl. Exports: Kodi .edl (start end action) for the TV; mpv segment
    EDL ("# mpv EDL v0") only as a convenience for plain-mpv users.
D5  Per-range actions: skip, hide (black overlay + mute, zero decode cost, DEFAULT alternative to
    skip), blur (best effort; auto-falls back to hide when the machine cannot keep up). [pending
    owner approval, question 4]
D6  Clean copy: keyframe-snapped stream copy (-c copy), cut snapped OUTWARD (removes a little more),
    minutes not hours, lossless. Optional precise re-encode. [pending approval, question in
    critique]
D7  One decode pass per movie yields sampled frames, scene-cut scores and audio via pipes; no temp
    files on disk (brief 4.8 by construction).
D8  Thumbnails are blurred at extraction; no clear flagged frame ever touches disk. "Peek" behind
    PIN renders live and discards.
D9  Panic key: press 1 = hide+mute+start mark; press 2 = end mark, restore. Range saved as manual,
    parent-reviewed entry. Hidden time is skipped forward.
D10 Edition offset: auto-computed by correlating scene-cut timestamps between files.
D11 TV: Fire OS (owner's set), not Google TV/VIDAA. Paths: Kodi sideloaded + .edl; VLC from Amazon
    Appstore + clean copy on USB; optional LAN share (off by default). Cannot filter streaming apps
    on the TV; files only.
D12 Scans run at low priority and pause while the player is open (brief 4.2).
D13 Measurement harness built into the app: load owner's hand-marked files -> per-category misses
    and false alarms. Real-movie numbers come from the owner's machine only (brief 8.1, 8.3).
D14 Model choice (verified 2026-10-12; sizes are shipped quantized files):
    - Nudity: NudeNet v3 320n (640m optional), MIT, ~10 MB (~100 MB)
    - Sex w/o nudity, kissing, gore: CLIP ViT-B/32 image encoder int8, MIT, ~90 MB; prompt text
      embeddings precomputed so the text encoder is not shipped
    - Scene captions: Florence-2 base ONNX q4f16, MIT, ~250 MB
    - Audio events: YAMNet (521 AudioSet classes incl. "Wail, moan", "Gasp", "Pant", "Screaming",
      "Gunshot, gunfire", "Slap, smack", "Squish"), Apache 2.0, ~16 MB
    - STT: whisper.cpp small q5_1, MIT, ~190 MB (base q5_1 57 MB is weak in Spanish)
    - Dialogue LM: Qwen3-0.6B Q4_K_M GGUF, Apache 2.0, ~400 MB
    Total ~1 GB models; installed footprint ~1.8-2 GB with Electron, mpv, ffmpeg, Python, ORT.
D15 Gore has no mature off-the-shelf model; it is the weakest category and the in-app help says so.
D16 Browser extension: per-site adapters, main-world injected script for subtitle fetch (MV3 cannot
    read response bodies). On DRM sites dependable action = black-out + mute; seek is a bonus
    (Netflix ignores video.currentTime; its private player API breaks on updates).
D18 Peek (review screen): a parent may reveal a flagged frame only behind the PIN (re-asked after
    5 min), rendered LIVE from the video into memory (ffmpeg pipe -> data URL), shown while the
    button is held, never written to disk, never available in kid mode. Thumbnails on disk stay
    blurred (overrides the designer's "lighter blur" reading).
D19 Design accepted: Atkinson Hyperlegible Next (body) + Fraunces (titles), both OFL, bundled.
    Category colours carry redundant cues (icon, label, pattern); real colour-blind user test
    pending (owner).
D17 PIN is a deterrent, not a security boundary; hashed properly; settings tamper-evident; help says
    so plainly.

## Honest findings so far (brief 6.5)
- Qwen3-0.6B scores SDH-only windows such as "[moaning]" as 0; the lexicon carries that signal.
  Keep 0.6B for memory; re-evaluate 1.7B once the owner's hand-marked files give numbers.
- CLIP zero-shot flagged "gore" on a synthetic colour test pattern (red areas). Expect false
  alarms on real footage until thresholds are tuned against hand-marked movies. Catch-too-much
  is the brief's rule, but the review screen must make rejecting easy (it does: one click).
- Measured on this 4-core container, CPU only: NudeNet 54 ms/frame, CLIP 117 ms/frame,
  LM 1.1 s per 60 s dialogue window, vision stage peak 238 MB, LM stage peak 0.93 GB.
  A 2 h film at 1 fps: ~20 min vision + ~3 min LM + decode time, before audio/captions.
- Kid-mode seeks are intercepted before decoding; the after-the-fact enforcement remains as a
  safety net. A seek to a range end still decodes (and discards) frames from the previous keyframe.
- Blur fallback to hide is untested under real frame drops (needs a slow machine).

## Polish backlog (for the M9 board pass)
- Extension defaults `language` to strict; desktop presets default it off. Align to the desktop.
- Extension popup repeats the level explanation under all six categories; show it once per
  selected level or collapse unselected categories.
- Extension: Disney+ X-TIMESTAMP-MAP offset parsed but not applied; iframes unsupported.
- Player: blur fallback untested under real frame drops.

## Quality board (brief 5.2 + 5.2b) — what each reviewer will demand
- mpv/VLC engineer: no decode-path cost at playback; frame-accurate seeks landing on keyframes with
  lead-in; HEVC/AC3/DTS passthrough; no IPC race on skip; clean-copy via stream copy.
- Family-filtering product lead (VidAngel / ClearPlay benchmark): per-category levels, not raw
  thresholds; plain-language, NON-graphic per-scene descriptions a parent can read; a "what this
  filter does" explanation per level; filters summary before play ("12 scenes will be skipped");
  honest note that their catalogs are human-curated and ours is automatic + parent review.
- Common Sense Media benchmark: a per-movie "What parents need to know" card generated from the
  scan, non-graphic, per category with counts and intensity; age-style guidance without
  pretending to be an official rating.
- Kids-protection commission: fail-closed in kid mode (missing/corrupt skip file => refuse to play
  or play with maximum protection, never silently unfiltered); review never exposes a child or a
  parent to the scene; PIN and profile separation; audit trail of what was changed and when; no
  data leaves the device; bypass analysis documented.
- Privacy/security auditor: zero network calls (verifiable with a firewall log); no telemetry;
  models and binaries hash-verified; no clear flagged frames on disk; PIN hashing; tamper evidence.
- Non-technical parent: set-up once, anyone presses play; no jargon; Spanish (MX) and English (US);
  errors say what to do next; nothing ever requires a terminal.

## Decisions on open questions (planner, 2026-10-12, owner delegated)
Q1 No LICENSE file added (owner's legal call; GPL binaries stay separate executables). Build
   unsigned; help gets a first-launch page for Gatekeeper/SmartScreen. Revisit when certs exist.
Q2 Models bundled in the installer. Manifest with sha256; a "lite" build without 640m/Florence is
   a packaging option.
Q3 Assume 4 GB: one model at a time, low priority, pause while playing, plugged-in-only default.
Q4 Actions skip / hide / blur / mute / none as in SKIPFILE.md; hide is the default non-skip action.
Q5 Extension adapters in order: generic HTML5, YouTube, Netflix, Prime Video, Disney+.
Q6 Evaluation harness accepts native .bonis.json files as ground truth.
Q7 Fire TV help: USB + VLC (Appstore) primary; Kodi sideload + EDL as "advanced"; LAN share later.
Q8 Four active subagents.
Q9 `language` category exists in the format; default level off; action mute.

## Original open questions (kept for the record; owner may still answer and override)
Q1 Project licence (open source vs private) and signing certificates (Apple Developer, Windows
   code signing). Without them: "unidentified developer"/SmartScreen warnings on first launch.
Q2 Models inside the installer (~1 GB, offline from the first second; recommended) or one-time
   download on first run?
Q3 i5 generation and RAM of the scanning machine; are the scan-time estimates acceptable
   (2 h film: ~30-60 min with subtitles, 2-3x that when STT is needed, on an old i5 iGPU)?
Q4 Approve actions skip / hide / blur-best-effort, with hide as default alternative to skip?
Q5 Which streaming sites first for the extension (each is an adapter)?
Q6 Hand-marked skip files: how many movies, format, languages, any Spanish-audio films?
Q7 Fire TV: is a one-time Kodi sideload acceptable, or USB + VLC as the primary path?
Q8 Subagent cap: 4 (brief 7.5) vs 6 (profile). Using 4 unless told otherwise.
Q9 (new) Should "language/profanity" be an optional category? The subtitle pass finds it for
   free and muting by subtitle timing is cheap; VidAngel/ClearPlay reviewers will ask for it.

## Milestones (planned; update status here)
M0  Ledger + brief in repo ........................................ DONE 2026-10-12
M1a docs/PLAN.md + spec/skipfile.schema.json + SKIPFILE.md ........ DONE 2026-10-12
M1b Sonnet visual design system + logo (docs/DESIGN.md, tokens.css) DONE 2026-10-12 (reviewed)
M2  Skip-file spec v1 + validator + fixtures + EDL export ......... DONE 2026-10-12 (reviewed)
M3  Player: mpv control, Lua skip script, marking + panic keys .... DONE 2026-10-12 (reviewed)
M4  Analyzer v1: subtitles + frames, resumable, checkpointed ...... DONE 2026-10-12 (reviewed)
M5  App shell: library, review timeline, PIN, import/export, clean copy  todo
M6  Extension: subtitle pre-read + skip-file import ............... DONE 2026-10-12 (reviewed)
M7  Analyzer v2: audio + captions + fusion tuning + measurement .... todo
M8  Extension live-audio mode ..................................... todo
M9  Packaging (Win x64, macOS universal), in-app help (TV paths) .. todo

## Handoff note
Nothing is built. Repo layout proposed for M1: desktop/ (Electron, ES5 IIFE modules), analyzer/
(Python), player/ (mpv Lua + IPC), extension/ (MV3), spec/ (skip-file schema + fixtures), docs/.
