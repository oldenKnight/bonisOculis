# bonis oculis: board review, privacy and security auditor + senior mpv/VLC video engineer

Reviewer mode: read-only. No repository file was edited and no git write command was run.
Every experiment used synthetic media (lavfi colour fields, testsrc2, frame-number barcodes, sine
clicks). Scratch: `scratchpad/review/{x,cc,an,res,ort,edl,media}`.

## State reviewed

The tree changed under the review as other agents committed. Experiments ran against:

| when | state |
|---|---|
| first pass (player lab, screenshots, clean copy, EDL, traced scan, Electron launch) | `0fa5495` + uncommitted edits |
| resume runs, supervisor run, tamper re-runs | `b3d757d` (player lockdown, ViT nudity model, fail-closed parent mode, activity log) |
| final re-verification of every open finding | `e9f9503` (HEAD at writing, clean tree) |

Line numbers below are for `e9f9503`. A finding marked **FIXED** was reproduced on the earlier state
and re-tested on the later one.

---

## A. Privacy and security auditor

### A1. BLOCKER: the analyzer sends telemetry to Microsoft on every scan
- **Where:** `analyzer/requirements.txt:3-4` (`onnxruntime>=1.17`, unpinned); `.github/workflows/build.yml:65,178` installs whatever version is current. Installed here: onnxruntime 1.29.0.
- **What breaks:** ONNX Runtime 1.29 (pip, Linux) ships the Microsoft 1DS telemetry client.
  - One real-model scan of a 40 s clip opened **8 HTTPS connections to `mobile.events.data.microsoft.com`**. Seen with `strace -f -e connect,sendto`: `CONNECT mobile.events.data.micro…`, then TLS application data of about 1.4 KB per session.
  - It also wrote `~/.cache/Microsoft/DeveloperTools/.onnxruntime/onnxruntime.db`, a SQLite `events` table queued for upload. The table holds `EpDeviceUsage`, `SystemMetrics` and `RuntimePerf` events with a device id, the OS string (`24.04.5 LTS (Noble Numbat)`), an app session GUID, the process name, maxRss and CPU times.
  - It left `mat-debug-<pid>.log` and `.ses` in `$TMPDIR`. These files are not deleted, so brief 4.8 is broken as well.
  - Calling `onnxruntime.disable_telemetry_events()` before creating the session **did not stop the uploads** (8 connects again).
  - This breaks brief 4.7 and PLAN principle 6. `desktop/test/no-network.test.js` only greps the JavaScript, so it cannot catch a native library.
- **Fix:** Ship an ONNX Runtime built with telemetry compiled out, or pin and hash-lock a version proven not to upload. Add a CI gate that runs a real scan under `unshare -n` or `strace -e connect` and fails on any non-AF_UNIX connect. Apply the same gate to llama.cpp and whisper.cpp.

### A2. BLOCKER: the Electron app downloads a spell-check dictionary from Google at first launch
- **Where:** `desktop/main/window.js:51` sets `spellcheck: false`. `desktop/main/main.js:46-58` (`hardenSession`) installs a webRequest cancel filter, but neither touches the session's spellchecker.
- **What breaks:** A plain `xvfb-run electron .` with an empty userData produced `userData/Dictionaries/en-US-10-1.bdic` within 30 s. `Cache/Cache_Data` holds the request chain `redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic` → `rr*.gvt1.com/...&mip=<client IP>`. Reproduced twice: once under Playwright, once without it. The dictionary service's request bypasses `webRequest.onBeforeRequest`.
- **Fix:** On `ready`, before any window exists, call `ses.setSpellCheckerEnabled(false)` and `ses.setSpellCheckerLanguages([])`. Point `ses.setSpellCheckerDictionaryDownloadURL` at an unroutable local URL. Add an e2e test that launches the app under a network-denied namespace and asserts that `Dictionaries/` is empty.

### A3. FIXED in `b3d757d`/`64ebeed`: mpv screenshots wrote clear frames of hidden scenes
- **Original state (`0fa5495`):** mpv ran with default bindings. Hide and panic are an OSD overlay (`bonis.lua:317 draw_black`), and a video-mode screenshot skips the OSD.
  - Pressing `s` in **kid mode** during a hide range wrote `mpv-shot0001.jpg` into the app's cwd with average RGB `3,2,255`, which is the hidden blue content, not black.
  - `Alt+s` (screenshot each frame) wrote **25 clear frames** of the hidden range while the screen showed black.
  - `Q` wrote `~/.local/state/mpv/watch_later/*` entries.
- **Re-test on `64ebeed`:** mpv now runs with `--input-default-bindings=no`, an empty `player/input.conf`, and a screenshot directory under a regular file. `s`, `S`, `Alt+s` and `Q` in kid mode wrote nothing (cwd empty, watch_later unchanged), and seek enforcement still holds (A, B, C1, D, E below).
- **Residual:** the IPC socket can still issue `screenshot-to-file`. Only main uses it today. Keep it that way, and say in a comment that no app code may call it.

### A4. MAJOR: a hand-edited skip file plus library.json still yields Protected (kid mode fails open)
- **Where:** `desktop/main/store.js:130-145` (`readEnvelope` returns tampered data and only emits a toast). `desktop/main/main.js:91` (toast only). `desktop/main/skips.js:40` (`it.skipHmac && …`: a missing HMAC counts as untampered). `desktop/main/library.js:43-65` (the new "clean approval" check trusts a plain-text history entry).
- **Repro (`x/tamper2.js`, current tree):**
  1. Protected title with one approved range.
  2. Edit the skip file: `ranges: []`, and append the history entry `{event:'approved', detail:'no scenes found; approved for kids by a parent'}`.
  3. Edit library.json: delete `skipHmac`, set `status:'protected'`, delete `library.json.bak`.
  4. Boot. Result: `status: protected`, kid-playable, **0 enforced ranges**. The only signal is a `toast.tampered`.
- **Fix:** If library.json fails its HMAC, demote every Protected title to Needs review until the PIN re-signs. Treat a missing `skipHmac` on any title that has a skip file as tampered. Never derive approval from history text; store the parent's whole-title approval in the HMAC'd library index.

### A5. MAJOR: importing a third-party skip file can make a title Protected without review
- **Where:** `desktop/main/importers/json.js:24-51`. `scan.status` and `review` are taken from the file. The `imported` history entry blocks only the zero-range case.
- **Repro (current tree):** import a crafted file onto an unscanned title, picked by hand (`match:'manual'`). The file has `scan.status:'complete'` and one `approved` 0.5 s range at 39 s. Result: `status: protected`, kid-playable. The only warning is `offsetUnknown`. A downloaded, wrong-edition or malicious file therefore protects nothing.
- **Fix:** Imported ranges arrive as `pending`. Imported `scan.status` is ignored unless the fingerprint matches exactly. Kid mode for an imported title requires an explicit PIN-backed "I reviewed this list" step.

### A6. MAJOR: deleting secure.json removes the PIN; editing it resets the cooldown
- **Where:** `desktop/main/pin.js:73-83`. A missing `secure.json` and `.bak` silently creates a fresh one with `pin: null`.
- **Repro:**
  - **Delete:** remove both files and boot. `hasPin:false`, `locked:false`, `setupDone:true` (parent mode, no PIN), and `pin:set('7391')` succeeds for anyone. Only `tampered:settings.json` and `tampered:library.json` toasts appear.
  - **Edit:** after 6 wrong PINs (cooldown 29 997 ms), setting `failures/cooldownUntil/cooldownMs` to 0 in secure.json gives `triesLeft:5, cooldownMs:0` after a restart.
  - LEDGER D17 accepts the PIN as a deterrent, but a child on the same OS account needs only a file manager.
- **Fix:** If secure.json is missing while settings or the library exist, boot locked into a "PIN lost; use the recovery code" screen and never into parent mode. Keep the key and counters sealed with Electron `safeStorage` (OS keychain / DPAPI). Store `cooldownUntil` as monotonic time plus a failure count, so changing the clock or the file does not help.

### A7. MAJOR: locking the app does not put a running player into kid mode
- **Where:** `desktop/main/handlers.js:249-255` (`pin:lock`). No caller sends `set-kidmode`: grep finds `scriptMessage` only at its definition in `player-controller.js`.
- **Effect:**
  - A parent starts a title in parent mode. That may be unscanned (now behind `needsConfirm`) or have pending ranges, which parent mode enforces only by level.
  - The parent presses Lock and hands over the computer. mpv keeps running in parent mode: marking keys work, the parent seek rules apply and `q` quits.
  - The Lua side already supports the switch (`bonis.lua` `set-kidmode` handler with `fail_closed`).
- **Fix:** In `pin:lock`, if the player is open in parent mode, send `script-message-to bonis set-kidmode 1`. If the title is not kid-playable, stop the player.

### A8. MAJOR: exports ignore the current levels, so the TV copy protects less than the app
- **Where:** `desktop/main/handlers.js:287-307` export the raw document (`docOf`). Playback uses `buildPlaybackDoc` (`player-service.js:22-44`).
- **Repro:** a pending auto `gore` range with confidence 0.5 and action `none`, under the strict level. The app player's action is `skip`. `toKodiEdl` returns `""`, and clean copy cuts 0 ranges.
- **Fix:** Pass every exporter (`json`, `edl`, `clean`) through `buildPlaybackDoc(doc, currentSettings)`. For the TV path, also refuse or warn when pending ranges exist.

### A9. MAJOR (supply chain): unpinned dependencies; claimed runtime model verification does not exist
- `analyzer/requirements.txt` uses `>=` ranges with no `--hash`, and CI installs from it (`build.yml:65,178`). This is how A1 got in.
- `analyzer/models/manifest.json:7` says files are verified "at first app run". No code in `desktop/main` or `analyzer/bonis_analyzer` hashes models at runtime. Only `tools/fetch-models.js` checks, at build time.
- Positives: `tools/fetch-vendor.js` (extension ORT-web and YAMNet) and `packaging/binaries.json` pin sha256; package-lock has integrity hashes.
- **Fix:** Use a hash-locked `requirements.lock` (`pip install --require-hashes`). Either implement the first-run sha256 check against the manifest or remove the claim.

### A10. MINOR findings
- **Renderer-controlled paths** (`ipc.js:19,53`; `exporters/write-file.js:10`):
  - `library:add` accepts any path string. `/etc/passwd` was probed with ffprobe and rejected as `notVideo`.
  - `export:json` with `dir:<any folder>` wrote `main.bonis.json` into an arbitrary directory (verified through `window.bo.invoke`).
  - This is defence in depth only, since the renderer is local, sandboxed and CSP'd. Fix: accept only paths returned by the open/pick-folder dialogs, through one-time tokens as `import:json` already does.
- **Extension nonce is obtainable by any page script** (`extension/content/bridge.js:142`). The bridge re-announces the nonce on a `bonis-oculis:hello` event that the page can dispatch. A page can then post forged `track` messages, which feed auto-sync (`content/main.js` `syncDetail(pageCues(), …)`) and can shift an imported skip file's offset. Fix: announce once at `document_start` and ignore later hellos, or move the subtitle capture to `chrome.scripting` with a closure-captured MessageChannel port.
- **Extension "no request left 127.0.0.1" check** (`extension/test/run.js:314,904`) listens with `context.on('request')`. In Playwright Chromium this does not include service-worker or offscreen-document traffic without the experimental service-worker network flag, so the offscreen ORT-web and YAMNet path is not covered. This is from Playwright's documented behaviour; I did not run the browser suite. Fix: run the browser test with a proxy that logs every CONNECT, or with `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, and assert the log is empty.
- **Peek window slides** (`pin.js:182-185`): it opens on any unlock, not only a peek PIN, and every peek extends it, so continuous peeking never re-asks. PLAN 5.4 says "re-asked after 5 min". Fix: open the window only for `purpose:'peek'` and do not extend it.
- **Sharp poster written to disk by design** (`thumbs.js:96,107`, `poster-clear.jpg` at 480 px) when the title is Protected and no range lies within ±3 s. This frame is not flagged, but a detector miss puts a clear frame on disk. Fix: keep it in memory, or say so in the privacy screen.
- **Crashpad is initialised** (`userData/Crashpad/client_id` exists). If a renderer crash writes a local minidump, its memory may contain a peeked frame. Not reproduced. Fix: `app.setPath('crashDumps', <tmp purged at start>)`, or disable crash dumps.
- **Positives, verified:**
  - Kid-mode channel gating is enforced in **main**: 14 parent channels called through `window.bo.invoke` while locked all returned `locked`.
  - `player:play {kidMode:false}` while locked was forced into kid mode and returned `kidRefused` for an unprotected title.
  - PIN brute force hits the 30 s cooldown on the 5th try, and recovery shares it.
  - scrypt N=2^15 with `timingSafeEqual`.
  - The app log contained no paths, titles or PINs.
  - CSP `default-src 'self'`; contextIsolation, sandbox and webSecurity on; no `remote`.
  - Data at rest from a traced real-model scan: only `.npz`/`.json` checkpoints and (blurred) thumbs; no image or wav temp files. The exception is the ORT files in A1.

---

## B. Senior mpv/VLC video engineer

### B1. BLOCKER: the app can never finish a real scan, because the analyzer deletes its own output
- **Where:** `desktop/main/scanner-supervisor.js:268` passes `--out <work>/result.bonis.json`. `analyzer/bonis_analyzer/scan.py:343` then calls `ckpt.cleanup_after_done()`. `pipeline/checkpoint.py:104-117` removes every file in `<work>` except state, `.npz` files and thumbs, so it removes the result.
- **Repro (`x/supreal.js`):** the real supervisor plus the real analyzer and models on a 40 s clip.
  - Exit code 0 four times, then `finalStatus: needsAttention, error: badOutput` after 35 s.
  - Every direct CLI run with `--out` inside `--work` also leaves no `result.bonis.json` (`an/work`, `res/wU`, `res/wK`).
  - The e2e suite never sees this because it uses `tools/fake-analyzer.js`.
- **Fix:** Have `cleanup_after_done` keep the `--out` path (or never delete files it did not create). Point `--out` outside `<work>`. Add one CI test that runs the real CLI through the supervisor.

### B2. BLOCKER: clean copy keeps frames from the cut scenes
- **Where:** `desktop/main/exporters/clean-copy.js:121-123` (input-side `-ss <kf> -to <kf2>` with `-c copy -avoid_negative_ts make_zero`). The header comment at lines 5-8 claims no cut frame can survive.
- **Repro (`cc/drive.js`, `cc/verify.py`):** sources carry a 16-bit frame-number barcode. Each output frame was decoded and mapped back to its source time.

| source | cuts | leaked frames from cut ranges |
|---|---|---|
| H.264 MKV, `-g 48 -bf 2`, AAC + AC3 + SRT | [10.3,14.7] [30.2,31.1] [45.5,47.2] | **66** (e.g. src 14.042 s at out 11.152 s; src 47.125 s at out 42.733 s) |
| HEVC open GOP (x265 `open-gop=1`, bframes 4) | [10.3,14.7] [30.2,31.1] | **39** |
| MPEG-TS, start_time 1.402, first keyframe at 2.421 | [9,10] [20.5,23] | **11** (src 9.556–9.973 s) |
| MP4 without B-frames | [10.3,14.7] | 0 |

- **Cause:** for B-frame streams, the ffmpeg CLI seeks a margin before `-ss`, lands on the previous keyframe and copies the packets before the start point. `make_zero` then makes those frames presentable. Up to one GOP of every cut scene survives.
- **Fix:** Stop using input-side seeking for the cut. Either use the concat demuxer with `inpoint`/`outpoint` per kept segment on the original file, or output-side `-ss`. Then gate the export on a decode check: decode the result, compare it with the expected kept-frame count, and fail closed. Keep this barcode test in CI.

### B3. BLOCKER (usability) / MAJOR: clean copy drifts audio further out of sync with every cut
- **Same files.** Clicks at every integer source second, compared with the frame whose number is a multiple of 24 (milliseconds, positive = audio late):
  - MKV AAC: 0 → −77 → −262 → −453 after cuts 1, 2 and 3.
  - MKV AC3: 0 → −99 → −316 → +483.
  - HEVC: −327, then +439.
  - TS: up to 1986.
- **Cause:** each copied part ends its audio and video at different packet boundaries, and the concat demuxer chains parts by container duration.
- **Fix:** Cut video by stream copy and audio by sample-exact trimming (re-encode audio per part with `atrim` to the video part's packet-pts span). Assert the drift is below 40 ms per part with the click test.
- **Positive:** all streams were preserved (h264 + aac + ac3 + subrip; hevc + aac). One subtitle cue (30–32 s) that overlaps a hide range at 30.2–31.1 s survives as text (minor).

### B4. MAJOR: clean copy mixes timelines when the file does not start at 0
- **Where:** `desktop/main/probe.js:49-62` returns absolute `pts_time` keyframes. Input `-ss`/`-to` are relative to the file's start_time, and skip times are on mpv's rebased timeline.
- **Effect:**
  - TS start 1.402: the kept segments came out as `[2.421,8.421] [10.421,20.421] [24.421,…]` instead of the GOP-aligned gaps, and frames leaked (B2 table).
  - With a DVB-style start_time of hundreds of seconds, no keyframe is ≤ the first cut start. The kept-segment computation (`clean-copy.js:26-56`) then drops segments or returns `nothingLeft`. This case was derived from the code path and not run.
- **Fix:** Subtract `format.start_time` from the probed keyframes, or run every step with `-copyts` consistently. Add a TS fixture to the test.

### B5. MAJOR: resume adds a scene cut that does not exist, so the output differs from an uninterrupted run
- **Where:** `analyzer/bonis_analyzer/pipeline/decode.py:95` (`t > offset + 0.05` guard after a resume seek with a 2 s preroll).
- **Repro (`res/killrun2.py`, ViT model, 120 s, 30 shots):**
  - Two clean frames-stage runs: bit-identical scores and cuts.
  - The same run SIGKILLed at 50 %, then resumed: identical scores, but the cuts gained **58.06 s**, a cut that does not exist (preroll start 58 s + one frame). It goes into `media.fingerprint.sceneCuts` and into the shot boundaries used by fusion and captions.
  - The earlier full five-stage kill test (SIGKILL in frames, then in captions) differed in every second of the frame scores. That was because the nudity model changed under it (`nsfw-vit-int8` now); I discount it.
  - Captions, audio, LM and subtitle arrays were bit-identical across that kill and resume.
  - No orphan ffmpeg remained after either kill.
- **Fix:** On resume, discard showinfo cuts with `t < resumeAt` and keep the checkpointed ones, rather than using a 0.05 s guard.

### B6. MAJOR (by inspection): a paused analyzer keeps its model set in RAM during playback
- **Where:** `pipeline/checkpoint.py` `Pauser.check` blocks in place. Only `on_pause` flushes; the models stay loaded.
- LEDGER measures the LM stage at 0.93 GB. On the 4 GB minimum machine that memory stays resident while mpv plays, which works against brief 4.1/4.2.
- **Fix:** When the PAUSE reason is `player`, close the stage's model set and reload it on resume (each stage is already checkpointed).

### B7. Player enforcement measured on screen: PASS
Method: mpv `vo=x11` under Xvfb, ffmpeg x11grab at 60 Hz, and per-capture colour classification. Range content is solid red or blue, or a 4 px checker for blur. The **control** (no ranges) showed red in 116 of 182 captures, which proves the detector works. Leaked frames with protected content:

| scenario | leaked |
|---|---|
| play through skip (24 fps); play through hide | 0; 0 |
| parent absolute seek into skip; relative keyframe seek into skip | 0; 0 |
| paused absolute seek into hide | 0 (paused frame covered) |
| kid RIGHT into skip (lands 16.5) | 0 |
| resume `--start` inside skip, paused, then play | 0 |
| first range at 0 (skip; hide) | 0; 0 |
| parent `add chapter 1` into skip; kid PGUP | 0; 0 |
| `--keep-open` with skip range to EOF | 0 (stays black and muted at EOF) |
| parent backward seek into skip (lands 15.5) | 0 |
| hide + `window-scale 2`; hide + fullscreen toggle | 0; 0 |
| blur: play-through, seek into, resume paused inside, paused exact seek | 0 sharp frames |
| 6 CPU-hog processes: skip at 24 fps ×2, 60 fps ×2, blur, 8-seek spam into skip | 0 |
| after the lockdown (`64ebeed`): A, B, C1, D, E repeated | 0 |

- Mute: the user's mute is restored after a range, and unmuting inside a range is forced back.
- Caveats:
  - A single 16.7 ms frame at 60 fps can fall between two 60 Hz captures.
  - No GPU here, so `hwdec=auto-copy` with blur, 10-bit/HDR, and the frame-drop watchdog are untested.
  - Blur mutes 0.5 s early by design.

### B8. MINOR video findings
- **Subtitles can return during hide** (`bonis.lua:352-364`): `sub-visibility` is saved and cleared but not held. Mute has a hold observer (`:621`); subtitle visibility has none. No key toggles it since the lockdown, so only IPC or other scripts can, and it is minor. Fix: add an observer like the mute one.
- **Hide relies on the OSD:** anything that renders without the OSD, such as `screenshot-to-file` over IPC or a future embedded libmpv render, shows the clear frame. Document this in `player/README.md`.

### B9. EDL exports: PASS
- **mpv EDL:** `toMpvEdl` wrote `%len%`-quoted paths that mpv 0.37 played with the expected duration (27 s = 40 s minus 5 s skip, 5 s hide and 3 s mute). Tested with a path containing `, ; % = #`, a space and UTF-8 (`Pelí cula, #1;%=.mkv`), and with a path containing a newline.
- **Kodi EDL:** lines read `10.00 15.00 0`, `20.00 25.00 0` and `30.00 33.00 1`, matching the kodi.wiki `start end action` format (0 = cut, 1 = mute). Rejected ranges are excluded; pending ranges are included. Level handling has the problem in A8.

### B10. Analyzer decode: notes
- Frames are scaled to 320 px inside ffmpeg before the pipe, with the scene branch at 160 px, so memory on 4K sources is bounded by the decoder.
- Late-starting video (video start_time 3.0 s, audio 0) produced correct second labels: the red content at 13–17 s was labelled 13..17.
- The `-hwaccel auto` fallback path restarts from the next unseen second. It could not be exercised without a GPU.
- `SCENE_THRESHOLD = 0.3` at 160 px is a reasonable default; the 1 fps sampling limits are documented in LEDGER.

### B11. Working-tree note (first pass)
`desktop/test/scanner-supervisor.test.js:57` and `:143` failed on `0fa5495` plus uncommitted `tools/fake-analyzer.js` edits (280 vs 80; 70 vs 20). These were in-flight edits, but they show the supervisor tests depend on the fake analyzer's timing.

---

## Verdicts

**Privacy and security auditor: FAIL.**
- **Blockers:** A1 (ONNX Runtime telemetry to Microsoft on every scan); A2 (Electron fetches a dictionary from Google at first launch).
- **Majors to close before the next round:** A4, A5, A6, A7, A8, A9.

**Senior mpv/VLC video engineer: FAIL.**
- **Blockers:**
  - B1: no real scan can complete; the analyzer deletes the result the supervisor reads.
  - B2: clean copy keeps up to a GOP of every cut scene, with 66, 39 and 11 leaked frames measured.
  - B3: clean copy audio drifts out of sync, cumulative per cut, −453 ms after 3 cuts.
- **Majors:** B4, B5, B6.
- **Strengths:** the mpv enforcement itself is excellent: 0 leaked frames in about 30 measured on-screen scenarios, including under CPU stress. The `64ebeed` lockdown fixed the screenshot leak (A3).
