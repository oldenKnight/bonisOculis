# bonis oculis — Project brief (owner's specification, verbatim in substance)

Owner: oldenKnight. Repo: oldenKnight/bonisOculis. Dev branch: claude/cool-bohr-7j0gmi.
Status: SPECIFICATION PHASE. Owner has not yet approved implementation (see docs/LEDGER.md, "Open questions").

## 1. Task
1.1 Desktop app (Windows 10/11 and macOS, Intel and Apple Silicon) that detects (i) sexually explicit
    scenes (ii) gore in movies/TV series and skips them during playback. Fully offline.
1.2 Three pieces, one shared skip-file format:
    - desktop app = the core (analyzer + review + own player + import/export)
    - browser extension for Chrome/Brave (Manifest V3) = small companion for online video
    - TV: owner has a Hisense UHD 4K A6 series Fire TV integrated set; wants a "brother solution"
      for series/movies.
1.3 Stack (owner's current choice): Electron shell, mpv playback engine, bundled Python analyzer with
    ffmpeg included, local models only. User installs nothing extra. Suggest better frameworks before
    starting (done: Electron kept, see LEDGER decisions).
1.4 JavaScript: ES5, vanilla, separate files, IIFE-namespaced globals.
1.5 App name: "bonis oculis".
1.6 Core architecture rule: do NOT detect while playing. Scan beforehand, write a skip file of
    timestamps, let any player obey that file.

## 2. Design
2.1 Most modern GUI/UX. 2.2 For families and non-technical users (a parent sets it up once, anyone
presses play). 2.3 Logo file. 2.4 Aesthetics, fonts, visual design, art: drafted by Sonnet.
2.5 Review screens never show explicit frames: thumbnails of flagged ranges blurred by default.

## 3. Functionality
3.1 Analyzer (offline, once per movie). Signals:
    - frames: ffmpeg samples 1-2 fps into a local nudity classifier
    - subtitles/CC: keyword pass + local LM pass over dialogue windows; SDH cues like "[moaning]" count
    - audio: sound-event classifier; local STT when no subtitles
    - scene description: local VLM captions keyframes (implied scenes without nudity)
    - fusion: score each shot from all signals, snap ranges to real scene cuts, lead-in padding
3.2 Categories, each with own threshold: nudity, sex without nudity, implied, heavy kissing, gore.
    Tune to catch too much rather than too little.
3.3 Skip file (native JSON): list of {start, end, category, confidence, action} + title, duration,
    file fingerprint (so a skip file finds its movie); time-offset field for other editions.
3.4 Player (mpv): plays practically any file (MKV, HEVC, AC3/DTS); obeys skip file; per range: skip,
    blur or mute; hotkey to mark in/out by hand; panic key (hide + skip forward + save the mark).
    v1: mpv opens its own window, controlled by the app. Embedding comes later.
3.5 Review timeline: flagged ranges with blurred thumbnails; approve/reject/adjust edges/change
    category without watching the scene.
3.6 Library: add local movies, scan status, scan queue.
3.7 PIN lock: settings, thresholds, review behind a parent PIN.
3.8 Export/import: native JSON; EDL (Kodi); clean copy (ffmpeg writes a new file with scenes cut
    out, for USB/TV).
3.9 Browser extension (beta, in order): subtitle pre-read; user-provided .srt/.vtt; auto-sync by
    matching first captions; import desktop skip file; experimental live tab-audio classification
    (react only: black out + mute until scene ends); panic key; on DRM sites never read frames,
    skip-only.
3.10 TV: owner wrote "Google TV/Android TV -> Kodi + EDL; VIDAA -> clean copy over USB". CORRECTION
    (accepted in critique): the set runs Fire OS. Paths: Kodi sideloaded + EDL; VLC (Amazon
    Appstore) + clean copy via USB; optional LAN share. Document in in-app help.
3.11 Build order:
    1. skip-file format + EDL export + player with marking hotkey
    2. analyzer v1: subtitles + frames
    3. app shell: library, review timeline, PIN, import/export, clean copy
    4. browser extension: subtitle pre-read + skip-file import
    5. analyzer v2: audio + scene-description model + fusion tuning
    6. extension live-audio mode

## 4. Quality
4.1 Least memory; avoid overheating/battery drain; least size necessary.
4.2 Min hardware: Intel i5, 4 GB RAM, integrated graphics. GPU when present (Apple Silicon,
    NVIDIA/DirectML), CPU fallback. Playback must never stutter because of the app.
4.3 One scan at a time. Never crash: engine and main app known to be very stable.
4.4 Autosave by default (marks, review decisions, scan progress). Interrupted scan resumes.
4.5 Autorecovery by default on crash or corrupted skip file.
4.6 Languages: Spanish (MX) and English (US).
4.7 Privacy: nothing leaves the computer. No telemetry, accounts, cloud.
4.8 Principled memory: no leaks, no temp frames/audio chunks left on disk after a scan.

## 5. Quality standard
5.1 Full freedom to design/plan, faithful to the essence of the vision.
5.2 Must pass a review board of: senior mpv/VLC video engineer; product lead from an established
    family movie-filtering service; privacy & security auditor; non-technical parent.
5.2b (added 2026-10-12) Must ALSO pass: a kids-protection commission; and must excel, compared
    with: the Common Sense Media website, the VidAngel Chrome extension, the ClearPlay app.
5.3 Critic standard: utterly perfect, user friendly, best current GUI practice.
5.4 If it does not pass critic test and specs, keep going. 5.5 Don't stop until wowed vs real works.
5.6 Designed for people with kids who want an intuitive GUI/UX.

## 6. Rules
6.1 Human-friendly app for people with low tolerance for frustration.
6.2 Ask questions before starting implementation. 6.3 After approval: full freedom to finish.
6.4 Pause only to warn about departing from the essence of the vision.
6.5 Be honest about detector limits: measure misses/false alarms against hand-marked movies; show
    numbers per category.

## 7. Production process
7.1 Plan/design (architecture, UX): Fable 5.1. 7.2 Aesthetics/fonts/visual/art/logo: Sonnet.
7.3 Implementation: Opus 5.5 subagents, faithful implementers. 7.4 Review/critic: Fable 5.1.
7.5 Max subagent depth 2. Max active subagents 4. 7.6 Fix any agent stuck > 5 min.
7.7 Progress ledger + handoff note in repo; commit after each milestone; small resumable steps;
    on restart read the ledger instead of re-deriving context.

## 8. Warnings
8.1 Never download, generate or store sexually explicit or gore material for testing. Synthetic
    fixtures only (subtitle files, labelled placeholder clips, classifier scores fed as data) plus
    the owner's hand-marked skip files.
8.2 Check current local models and licences before choosing; report choice and download size.
8.3 Keep heavy vision scans minimal when testing. 8.4 Ask before starting if anything contradicts.

## Owner preferences (from profile)
Address the owner as a man. Owner knows JS ES5. Max subagent depth 2. Max active subagents 6 in
profile, but 7.5 says 4 -> use 4 unless told otherwise.
