# bonis oculis: board review round 2, privacy/security auditor + senior mpv/VLC video engineer

Reviewer mode: read-only. I edited no repository file and ran no git write command. All media is synthetic:
- lavfi colour fields and testsrc2;
- 16-bit frame-number barcodes over a moving noise field;
- band-limited noise audio with a click at every source second;
- SRT cues.

Scratch: `scratchpad/review2-sec/` (symlinked as `/tmp/r2`). The scripts are in `scripts/` and the raw results sit next to them.

## State reviewed

| when | state |
|---|---|
| A1/A2 first traces | `e4587ae` (HEAD at start, clean tree) |
| everything else | snapshot `/tmp/r2/snap` = `72945b0` + uncommitted round-2 app edits |
| at writing | HEAD `b4d564b` (clean tree) |

I diffed the snapshot against `b4d564b` for `desktop/main`, `desktop/preload.js`, `player/`, `analyzer/bonis_analyzer`, `analyzer/requirements.txt` and `shared/`. They are byte-identical, so every result below applies to `b4d564b`. Line numbers are for `b4d564b`.

Test environment: 4 vCPU, no GPU, ffmpeg 6.1, mpv 0.37.0, Electron from `node_modules`, Python 3.13. The scan runs used `BONIS_MODELS_DIR=scratchpad/models` with real models (ViT nudity, CLIP, Florence-2, YAMNet, whisper small, Qwen3-0.6B).

---

## 1. Round-1 findings: status and proof

### Privacy and security auditor

| # | round-1 finding | status | measurement |
|---|---|---|---|
| A1 | ONNX Runtime 1DS telemetry to Microsoft on every scan | **fixed** (Linux measured; macOS/Windows by inspection only) | Each run is a full 6-stage real-model scan of a 40 s clip with `--force-speech`, private `HOME` and `TMPDIR`, under `strace -f -e connect,sendto,sendmsg,openat,...`. **ORT 1.29.0** (system python, the dev default `python3`): **0** connect/sendto/sendmsg syscalls, **0** files under HOME or TMPDIR, no `mat-debug-*.log`, `.ses` or `DeveloperTools` cache. **ORT 1.28.0** (the pinned version): the same, 0/0. **Control** (`ort1.py`, ORT 1.29, no env switch): 6 non-AF_UNIX connects (DNS to 8.8.8.8, then `:443` to 4.150.223.114), plus `onnxruntime.db`, `deviceid`, `.ses` and `mat-debug-*.log` created. This proves the detector works. **Control + `ORT_DISABLE_TELEMETRY=1`**: 0 connects, 0 files. CI gate present: `build.yml` "Analyzer privacy proof (strace, real models, zero sockets)", Linux only. |
| A2 | Electron downloads a spell-check dictionary from Google at first launch | **fixed** | **(a)** Plain `xvfb-run electron .` with empty userData, private HOME/TMPDIR, 60 s under `strace -f -e connect,sendto`: 15 AF_UNIX connects, 2 AF_NETLINK, **0 AF_INET/AF_INET6**. `Dictionaries/` is empty; the cache holds no URL. `Preferences` has `spellcheck.dictionaries:[]`. **(b)** The repo's `desktop/test/no-sockets.test.js` passes (wizard, scan, review, Help, About). **(c)** My variant of that driver uses the **real Python analyzer with real models** and then **opens mpv**: 36 traced processes (Electron, Python, ffmpeg, mpv), **0 IP connects**, `Dictionaries/` empty. |
| A3 | mpv screenshots wrote clear frames of hidden scenes | **fixed for keys**; IPC residual documented (`player/README.md` "Residual risk") | §3 below. All 128 default mpv keys plus the bonis keys were injected during a kid-mode hide range and during a panic cover: **0 files written by any key**. `screenshot`, `screenshot video/window/subtitles/each-frame` all return "error running command" (strace: `mkdir .../input.conf/no-screenshots = ENOTDIR`). Over raw IPC, `screenshot-to-file <p> video` still writes the hidden frame: average RGB **0,0,255**, the hidden blue scene. The `window` mode gives 2,0,3 (black). |
| A4 | Hand-edited skip file + library.json gives Protected (kid mode fails open) | **fixed against hand edits**; open against a script (see A6) | Real app, round-1 recipe: skip `ranges:[]`, forged "no scenes found; approved" history, `skipHmac` deleted, `status:'protected'`, `wholeApproved:true`, `.bak` deleted. Result: toasts `toast.tampered` and `toast.skipTampered`, then `needsReview`, `outside:'changed'`. Kid list: not shown. `player:play` in kid mode returns **kidRefused**. **Variant A4key**: the key was read from plaintext `secure.json` and `skipHmac` and the library HMAC were recomputed. Result: `protected`, 0 enforced ranges, kid mode **PLAYS**, no toast, no activity entry. |
| A5 | Imported third-party skip file makes a title Protected without review | **fixed** | Crafted file (`scan.status:'complete'`, an approved/locked range) imported onto an unscanned title via the real dialog/token flow (manual pick): `needsReview`, `outside:'imported'`, range arrives `pending`, kid play refused. The same holds with an **exact fingerprint** and 0 ranges: `needsReview`/`imported`, kid play refused. |
| A6 | Deleting secure.json removes the PIN; editing it resets the cooldown | **partly fixed** | **Delete secure.json + .bak** (recovery.json kept): boots `locked`, `pinLost:true`; `pin:set` is refused; kid play is refused. This is fixed. **Delete secure.json and recovery.json (+.bak)**: boots **unlocked parent mode**, `hasPin:false`; anyone can `pin:set`. Lists go to Needs review, but `player:play {unprotected:true}` **plays**. Not fixed. **Forged recovery.json** (attacker's own code wrapping an attacker key; the file is self-authenticating, `pin.js:213-225`): `pin:recover` gives `restored:true`, a new PIN and parent mode. Not fixed. **Cooldown**: 6 wrong PINs give `cooldownMs 29988, triesLeft 0`. After editing `failures/cooldownUntil/cooldownMs` to 0 and restarting: `cooldownMs 0, triesLeft 5`, no toast. Not fixed. No `safeStorage` anywhere in `desktop/main`. |
| A7 | Lock does not put a running player into kid mode | **fixed** | A protected title playing in parent mode, then `pin:lock`: mpv `user-data/bonis.kid` goes from false to **true** over the real IPC socket, and `player:status.kidMode` becomes true. An unscanned title playing in parent mode (`unprotected:true`), then lock: the player **stops** (`state: idle`). |
| A8 | Exports ignore current levels | **fixed** | Levels set to gore strict and kissing off. A pending auto gore range (conf 0.5, `action none`) and a pending kissing range (0.95) were added. Player play file: gore **skip**, kissing **none**. JSON export: the same. Kodi EDL: `33.00 36.00 0` present; kissing absent. Clean copy: kept 30.83 s of 40 s, both cut. Export renderer shows `export.notReviewed` when ranges are pending. |
| A9 | Unpinned deps; claimed first-run model verification did not exist | **partly fixed** | `requirements.txt` is now exact `==` pins with platform markers. However: no `--hash`, CI runs `pip install --prefer-binary -r` without `--require-hashes` (the file says "Next step (not done)"), and the whisper-cli pins are still `PIN_ON_FIRST_FETCH`. The runtime check is **implemented and works**: `integrity.js` with `BONIS_VERIFY_RESOURCES` pointed at a tree with **4096 bytes flipped** in `nsfw-vit-int8.onnx` reported `{checked:18, damaged:[models/nsfw-vit-int8.onnx: mismatch]}` after **8.9 s**, with a toast and an activity entry. Gaps are listed in N3. `analyzer/models/manifest.json:7` still says "There is no runtime check at first app run". |
| A10 | Minor items | **partly** | **Fixed:** export to an unpicked folder returns `forbidden` (measured); peek opens only for `purpose:'peek'` and no longer slides (`pin.js:197`, `touchPeek` no-op). **Partly:** the extension test now asserts offscreen-document resources (`extension/test/run.js:676`), but service-worker fetches are still not proxied. **Not fixed:** `library:add` still takes renderer paths (`handlers.js:161`); the extension nonce is still re-announced on page `hello` (`bridge.js:142`); `poster-clear.jpg` is still written (`thumbs.js:96`) and is not disclosed in Help; `userData/Crashpad/client_id` is created (crash dumps not disabled). |

### Senior mpv/VLC video engineer

| # | round-1 finding | status | measurement |
|---|---|---|---|
| B1 | The analyzer deletes the result the supervisor reads; no real scan can finish | **fixed** | **(a)** Real supervisor + real `python3 -m bonis_analyzer.cli` + real models on the 40 s clip: exit 0 after 46 s; status `needsReview` (clean, waiting for a parent click); `<id>.auto.bonis.json` kept; the `--out` file is consumed. The work dir holds only `*.npz`, `state.json` and thumbs. **(b)** Full Electron app with the real analyzer: exit 0, `needsReview`. `scanner-supervisor.test.js` + `real-analyzer.test.js`: 9/9 pass. |
| B2 | Clean copy keeps frames of the cut scenes | **fixed** for the four round-1 source classes; 1 frame remains on MKV with negative start (N1) | Barcode decode of every output frame (§2): H.264 B-frame MKV **0** inside-range frames on the ffmpeg timeline and **1** on mpv's timeline (src 31.083 s; cause N1). Open-GOP HEVC: **0 / 1** (31.083 s, N1). MPEG-TS, start 1.4027, mid-GOP start with undecodable leading frames, a cut at 0: **0**. 2 s-GOP MP4 (`-bf 3`, a cut running to EOF): **0**. DVB-like TS, start 601.4: **0**. Round 1 measured 66 / 39 / 11. |
| B3 | Clean-copy audio drifts with every cut | **fixed** | Each 20 ms output audio window was cross-correlated against the source track (search ±0.35 s) and compared with the source time of the video frame on screen. The table in §2 gives drift per kept segment and per track. Worst **4.8 ms** (H.264 MKV, AAC, segment 3). AC3 track ≤1.3 ms. TS AAC/MP2 ≤3.7 ms. **0** audio windows from inside any cut, on every source with a matching timeline. Round 1: −453 ms after 3 cuts. |
| B4 | Clean copy mixes timelines when the file does not start at 0 | **fixed for MPEG-TS**; new timeline bugs for MP4/MOV and MKV (N1, N2) | TS start 1.4027 and TS start 601.4: 0 leaked frames, drift ≤1 ms, cut at 0 handled. MKV with start 1.403 or 601.4: export **fails closed** (N2). MP4 with start 1.402: 54 leaked frames on the player's timeline (N1). |
| B5 | Resume adds a scene cut that does not exist | **fixed** | 120 s, 30-shot clip, stages subtitles+frames+audio+captions (lm and fusion implied), real models. Two clean runs (U, U2) against a run SIGKILLed at **frames 0.50** and again at **captions 0.51**, then resumed (K). Every `.npz` array (frames, audio, lm, captions, subtitles, fusion) is **bit-identical** across U, U2 and K. sceneCuts: 29 = 29, equal. Final skip files are equal. 0 orphan `ffmpeg` (`pgrep -x ffmpeg`). |
| B6 | Paused analyzer keeps its models in RAM during playback | **fixed** | `PAUSE` created mid-stage and RSS sampled every 2 s for 45 s. **LM**: 973 MB until t=20 s, then **77 MB** (log "released model set lm"); reloaded on resume (960 MB). **Captions**: 564 MB, then **91 MB**, reloaded (520 MB). Scan completed. Outputs are **bit-identical** to the uninterrupted run U. |
| B7 | Player enforcement on screen: PASS | **not regressed** (spot-checked, not re-measured with x11grab) | Kid playback of an MP4 starting at 0: a `skipped` event at the first range. During a hide the window screenshot is 2,0,3 (black) and the cover survives `osd-level 0` and `sub-visibility yes`. The lockdown run (§3) shows seek interception still active. |
| B8 | Subtitles can return during hide; hide relies on the OSD | **not fixed in code, measured harmless**; the OSD reliance is documented | IPC `set sub-visibility yes` during a kid-mode hide **sticks** (no hold observer). The cue "SECRET LINE IN HIDDEN SCENE" is active, but the window screenshot has **0** pixels above 180/255. The control outside the range has **118**, so the cover is drawn above subtitles. README documents the OSD residual. |
| B9 | EDL exports: PASS | **pass, now level-aware** | See A8. |
| B10 | Analyzer decode notes | unchanged | Observation: label second *t* carries the frame at *t*+0.458 s (fps filter rounding), measured on 4 files. Padding absorbs it. |
| B11 | Supervisor tests depended on fake-analyzer timing | **resolved** | 9/9 pass. |

---

## 2. Clean-copy measurements (frame barcode + audio correlation)

**Method.**
- **Driver:** `scripts/ccdrive.js` calls the real `cleanCopy()`, using libx264 picked by `encoders.js` with 2 threads.
- **Verifier:** `scripts/ccverify.py`.
- **Source-frame map:** source frames are decoded with `-copyts` and each frame's 16-bit barcode is mapped to its raw pts.
- **Two timelines:** each output frame is mapped back to its source time on two timelines:
  - **fmt**: pts − `format.start_time`, which is what the clean copy and the analyzer use;
  - **mpv**: pts − mpv `demuxer-start-time`, measured per file, which is what the player and the parent's marks use.
- **Leak:** a frame whose source time t lies in [start, end).
- **Audio:** every 20 ms output window is located in the source track by normalised cross-correlation (threshold 0.6, ±0.35 s search). Drift = audio source time − video source time at the same output instant. A leak is a window whose source position lies more than 10 ms inside a cut.

**Video leaks** (60 s, 24 fps, 320×180):

| source | cuts | out frames | leaked (fmt) | leaked (mpv) | over-cut |
|---|---|---|---|---|---|
| H.264 MKV, `-g 48 -bf 2`, AAC + AC3 + SRT, fmt start −0.021, mpv 0 | [10.3,14.7] [30.2,31.1] [45.5,47.2] | 1269 | 0 | **1** (31.083) | 2 |
| HEVC open GOP (x265 `open-gop=1:bframes=4`), fmt −0.021, mpv 0 | [10.3,14.7] [30.2,31.1] | 1311 | 0 | **1** (31.083) | 1 |
| MPEG-TS, start 1.4027, copied from mid-GOP with `-copyinkf`, AAC + MP2 | [0,1.5] [9,10] [20.5,23] | 1294 | 0 | 0 | 0 |
| MP4, 2 s GOP, `-bf 3`, AAC | [10.3,14.7] [30.2,31.1] [55,61] | 1191 | 0 | 0 | 0 |
| TS, start 601.4 | [10.3,14.7] [30.2,31.1] | 1311 | 0 | 0 | 0 |
| MP4 remuxed with `-copyts`, start 1.402, mpv 0 | [10.3,14.7] [30.2,31.1] | 1263 | 0 | **54** | 56 |
| MKV remuxed with `-copyts`, start 1.403 / 601.4 | [10.3,14.7] | — | **ffmpegFailed** (verify: duration 54.565 vs kept 55.973; 55.573 vs 656.97) | | |

Across all six outputs: unknown barcodes 0, duplicates 0, non-monotonic 0.

**Audio drift**, median / max |ms| per kept segment (segment 0 = before the first cut):

| source | track | seg 0 | seg 1 | seg 2 | seg 3 | audio leaked |
|---|---|---|---|---|---|---|
| H.264 MKV | AAC | 0.0 / 0.0 | 0.2 / 0.2 | 0.2 / 0.2 | 4.8 / 4.8 | 0 |
| H.264 MKV | AC3→AAC | 0.0 / 0.0 | 0.0 / 1.3 | 1.3 / 1.3 | 0.0 / 0.0 | 0 |
| HEVC | AAC | 0.0 / 0.0 | 0.2 / 0.2 | 0.2 / 0.2 | – | 0 |
| TS | AAC / MP2→AAC | – | 0.0 / 0.0 | 3.7 / 3.7 | 0.0 / 0.1 | 0 / 0 |
| MP4 2 s GOP | AAC | 0.0 / 0.0 | 4.6 / 4.7 | 0.0 / 0.0 | – | 0 |
| TS 601.4 | AAC / MP2 | 0.3 / 0.7 | 0.4 / 0.7 | 0.3 / 0.7 | – | 0 / 0 |
| MP4 start 1.402 | AAC ×2 | ≤0.1 | ≤0.1 | ≤0.1 | – | **111 windows** (2.2 s, on the mpv timeline) |

The TS cut at 0 removes segment 0, so the TS row starts at segment 1.

Cost: 4.4 s for 60 s at 320×180 with libx264 and 2 threads.

---

## 3. mpv lockdown: injection over IPC

**Setup.**
- **Launch:** mpv runs with the app's exact `buildArgs()`: `savePosition:false`, kid and parent modes, `vo=x11` under Xvfb, private HOME/TMPDIR/cwd, under `strace -e openat,creat,rename,unlink,mkdir,connect`.
- **Media:** the frame is blue in the 10–20 s hide range; an SRT cue in that range reads "SECRET LINE IN HIDDEN SCENE".
- **Injected, in order** (161 items):
  1. the screenshot commands;
  2. all **128 default mpv bindings** extracted from the mpv 0.37 binary's built-in `input.conf`, plus the bonis keys and `Ctrl+SPACE`;
  3. raw IPC property commands.
- **Checks:** 50 properties plus `user-data/bonis` were snapshotted before and after each injection, and the tree was watched for new files.

**Scenarios:** kid hide (paused at 13.3 s inside the range), kid panic cover (28 s), and parent hide.

**What changed state, and why:**
- **Keys:** only the documented bonis key set changed state: SPACE, arrows and Shift arrows, Shift+PGUP/PGDWN (seeks are intercepted), `f`, ENTER and double click (fullscreen or panic end), ESC, `m`, `9`/`0`, `p` and `Ctrl+SPACE`.
  - In the kid-mode hide, RIGHT moved to 20.0, the range end. The cover was released only there.
  - Kid mode: `q`, `Q`, `ESC` (windowed), `POWER`, `STOP`, `CLOSE_WIN`, `Ctrl+w`, `Ctrl+c` and `MBTN_BACK/FORWARD` did nothing. The process survived all 155 keypresses.
  - Parent mode: `q` quits, as documented.
- **Files written by keys:** none.
- **Screenshot commands:** all five `screenshot …` variants fail.
- **Things only a same-user process holding the socket can do:**
  - `screenshot-to-file <path> video` / `subtitles`: writes the clear hidden frame (RGB 0,0,255). `window`: black (2,0,3).
  - `write-watch-later-config`: creates `~/.local/state/mpv/watch_later/` with 4 files, although the app runs mpv with `savePosition:false`.
  - `script-message-to bonis set-kidmode 0`: switches kid mode **off** (`user-data/bonis.kid` false). After that, `q` quits the kid session.
  - `set sub-visibility yes`: sticks, but the subtitles stay covered (B8).
  - `set osd-level 0` and `osd-overlay` removal of ids 0/1: the cover survives (window RGB 2,0,3).

---

## 4. NEW findings

### N1. BLOCKER (video, kid mode fails open): the player and the analyzer/clean copy use different timelines when a file's `start_time` is not 0
- **Where:**
  - `player/bonis.lua:547` enforces on mpv `time-pos`.
  - `desktop/main/player-controller.js:101` passes `--start=<resumeAt>` on the same timeline.
  - `analyzer/bonis_analyzer/pipeline/decode.py:37-51` uses ffmpeg without `-copyts`; ffmpeg subtracts `format.start_time`.
  - `desktop/main/exporters/clean-copy.js:302` computes `pts - info.start`.
- **Root cause:** mpv does **not** rebase MP4/MOV, nor MKV with a negative start, while ffmpeg/ffprobe do. Measured `demuxer-start-time` and first `time-pos`:

  | file | ffprobe `format.start_time` | mpv `demuxer-start-time` | first `time-pos` |
  |---|---|---|---|
  | MP4 | 1.402 | 0 | 2.46 |
  | MP4 and MOV | 601.4 | 0 | **601.46** |
  | MKV | −0.021 | 0 | — |
  | TS and MKV with positive start | 1.40 / 601.4 | rebased (consistent) | — |

  Mapping each analyzer second label to the mpv time of the same barcode gives these offsets:
  - MP4 start 1.402: **+1.879 s**, against +0.458 s on normal files;
  - MP4 start 601.4: **+601.879 s**.
- **End-to-end repro (real app, `scripts/offset600.js`):**
  1. Remux a recording with `ffmpeg -copyts -i rec.ts -c copy rec600.mp4` (start 601.4).
  2. Add the file, approve its ranges (12–14.4, 27–29.4, 42–44.4) and lock.
  3. Play in kid mode. mpv runs from 601.46 s to 623.8 s, and **no `skipped` event fires**: every protected scene plays.
  4. Control: the same pipeline with a start-0 MP4 gives `skipped rfake0001` at 12 s.
  5. With start 1.4 s (a typical TS→MP4 `-copyts` remux), the last ~1.4 s of every scene, minus the 1 s tail pad, plays in the player.
  6. In the clean copy of the same file, parent-marked (mpv-time) ranges are shifted the other way: 54 frames and 2.2 s of audio from inside the cuts are kept, and 56 innocent frames are removed.
  7. MKV with the common −0.021 s audio-priming start: 1 frame (42 ms) per cut can survive in the clean copy (31.083 s above).
- **Severity:** **BLOCKER**. Kid mode silently enforces nothing for a whole class of files, with no warning. Ranges from two sources (analyzer and parent marks) live on two different timelines in the same skip file.
- **Fix:**
  1. Probe `format.start_time` once at library add and store it with the item, together with the container.
  2. In `bonis.lua`, on `file-loaded`, compute `delta = probedStart − demuxer-start-time`. Add it to every range, to `--start`, and to seek targets, and subtract it from marks and panic ranges.
  3. Have the clean copy and the analyzer keep their current (ffmpeg) convention.
  4. Add fixtures: MP4 start 601.4, MOV start 1.4, MKV start −0.021. Add a test that plays them in kid mode and asserts a `skipped` event.
  5. Until this ships, refuse kid mode, with a parent-facing message, when `|probedStart − demuxer-start-time| > 1 frame`.

### N2. MINOR (video, fails closed): clean copy refuses any MKV with a positive start_time, and the library shows the wrong length
- **Where:**
  - `clean-copy.js:116` builds `end` from `format.duration`, and `clean-copy.js:353` checks the result against it. For Matroska, lavf's `format.duration` is the **end timestamp**: start 1.403 gives 60.432, and start 601.4 gives **661.432** for a 60 s file.
  - `probe.js:35` stores the same value as the item duration.
- **Repro:** `ffmpeg -copyts -i full600.ts -c copy rec600.mkv`, then clean copy fails with `ffmpegFailed`, "verify: duration 55.573 vs kept 656.973". The library shows an 11-minute movie.
- **Fix:** use `duration − start_time` for Matroska when start > 0, or derive the duration from the last packet time (`times[n-1] + step`) in both places.

### N3. MINOR (security): the integrity check is advisory and runs once per version
- **Where:** `desktop/main/main.js:213-224` and `integrity.js` `needed()`.
- **Repro:** with the corrupted ViT model (4 KB flipped), the check flags it, but:
  - `scan:queue` is still accepted;
  - the analyzer loads the model and finishes without a warning (`rc 0`, nudity scores differ by up to 0.0019 on the same clip);
  - after the result is stored for version 0.1.0, it never runs again, so a file damaged later is not noticed.
- **Fix:** block scanning (and mark scans `needsAttention`) while `integrity.damaged` is non-empty. Have the analyzer verify the sha256 of the models of each stage it loads against the manifest; this is cheap next to inference. Update `manifest.json:7`.

### N4. MINOR (security, same-user IPC): `set-kidmode 0` is accepted
- **Where:** `bonis.lua:950-956` accepts `0`. The app only ever sends `1` (`player-service.js` `enterKidMode`).
- **Repro:** over the mpv socket, `script-message-to bonis set-kidmode 0` gives `kid:false`, and `q` then quits the kid session (§3).
- **Related:** `write-watch-later-config` writes a watch-later state directory despite `savePosition:false`.
- **Fix:** make the handler one-way (ignore anything but `1`). Pass `--watch-later-dir=<an unwritable path>` (the same trick as the screenshot directory), or `--no-resume-playback` plus a path under a regular file.

---

## 5. Verdicts

**Privacy and security auditor: PASS, with conditions (no blockers).**
- **Closed:** both round-1 blockers, measured with syscall traces on real models and on a full Electron first launch including a real scan and mpv playback.
  - A1: 0 IP sockets with ORT 1.29 and with ORT 1.28.
  - A2: 0 IP sockets across 36 processes; no dictionary.
  - A4, A5, A7 and A8 are fixed and measured.
- **Open and must close before release (non-blocking under LEDGER D17):**
  - **A6, partly fixed.** The PIN file and the HMAC key are plaintext. Deleting two files, or forging recovery.json, gives parent mode. Editing secure.json resets the cooldown. A script can re-sign a list as Protected with 0 ranges (A4key). Fix: seal secure.json with Electron `safeStorage`; refuse parent mode when the library or settings exist but no PIN material does. I do not rate this a blocker: anyone who can delete files in userData can also open the movie file in another player.
  - **A9, partly fixed.** No hash lock; whisper-cli pins are unresolved; N3.
  - **A10 minors:** `poster-clear.jpg` is undisclosed, Crashpad is on, the extension nonce is re-announced, `library:add` takes renderer paths.

**Senior mpv/VLC video engineer: FAIL. One blocker.**
- **Blocker N1:** the player and the analyzer/clean copy disagree on the timeline for MP4/MOV with a non-zero `start_time`, and for MKV with a negative start. Measured: kid mode on an MP4 starting at 601.4 s enforced **nothing** (no skip event in 22 s across a range that a start-0 control skipped). At 1.4 s, the scene tails play and the clean copy keeps 54 frames.
- **Closed:**
  - B1: the real supervisor + real analyzer finish.
  - B2: 0 leaked frames on H.264 B-frame MKV, open-GOP HEVC, mid-GOP TS at 1.4 s, 2 s-GOP MP4 and TS at 601 s (on the ffmpeg timeline).
  - B3: A/V within 4.8 ms per segment and per track, 0 audio from cut ranges.
  - B4 for TS.
  - B5: bit-identical arrays and cuts after SIGKILL in frames and in captions.
  - B6: LM 973→77 MB and captions 564→91 MB while paused, bit-identical after reload.
- **Lockdown:** sound against every default key in both modes. The residuals (`screenshot-to-file`, `set-kidmode 0`, `write-watch-later-config`) need the same-user IPC socket.
- **Minor:** N2. B8 is harmless as measured.

Scripts and raw outputs:
- `scratchpad/review2-sec/scripts/`: `a1scan.sh`, `drv-real.js`, `supreal.js`, `gen.py`, `ccdrive.js`, `ccverify.py`, `anatime.py`, `tamper.js`, `a7a8.js`, `integ.js`, `killrun.py`, `cmpres.py`, `pauserss.py`, `lockdown.js`, `subvis.js`, `osdlvl.js`, `offset600.js`;
- `scratchpad/review2-sec/lk/*.json`;
- `scratchpad/review2-sec/a1-*/strace.log`;
- `scratchpad/review2-sec/a2*/`.
