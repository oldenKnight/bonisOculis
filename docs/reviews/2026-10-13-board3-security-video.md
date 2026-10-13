# bonis oculis: board review round 3 (final verification), privacy/security auditor + senior mpv/VLC video engineer

Reviewer mode: read-only. I edited no repository file and ran no git write command. The tree was clean at `8e75c88` (HEAD) from start to end. All media is synthetic: a 16-bit frame-number barcode over moving noise (24 fps, 320×180) with noise audio, plus SRT text.

Scratch: `scratchpad/review4-sec/` (symlinked as `/tmp/r4`, because Electron's singleton socket path overflows the 108-byte unix-socket limit under the long scratchpad path). Scripts are in `scripts/`; raw results sit next to them.

Environment: 4 vCPU, no GPU, ffmpeg 6.1.1, mpv 0.37.0, Electron and Playwright from `node_modules`, Python 3.13, ORT 1.29.0. Real models came from `scratchpad/models`.

---

## Status table

| item | status | evidence (details below) |
|---|---|---|
| **N1** player/analyzer timeline (BLOCKER in round 2) | **fixed** | Real app, kid mode, 4 files (MP4 at 601.378, MKV at −0.021, TS at 1.462, control). 6/6 skips fire at the right skip-file times, and the hide range is covered on all 4 (192 in-range samples, 0 uncovered). The on-screen frame matches skip-file time to **0 ms** at 16 paused probes. |
| N1: old library entry without `start` | **works** | Through the `ensureStart` unit API with the real ffprobe: start was probed, passed to the player and persisted for all 4 files. When the probe fails, start stays unknown and `bonis.lua` refuses kid mode. |
| N2 MKV with positive start / duration | **fixed** | Clean copy of an MKV starting at 601.4 succeeds: 0 leaked frames, duration verified. |
| **N3** integrity advisory only | **partly fixed** | Scans are refused and the file is named (banner, toast, card). A damaged `bonis.lua` stops the player in both modes. Still open: the check runs once per version, so a file damaged later is missed until a manual check; and the analyzer does no per-stage hash check. |
| **N4** `set-kidmode 0`, watch-later | **fixed** | `set-kidmode 0` is ignored in the real kid session and in the standalone lockdown. `q` still does nothing in kid mode. `write-watch-later-config` writes nothing (`mkdir … no-watch-later` gives ENOTDIR, and no file appears under HOME, TMP, userData or player/). |
| A3 / lockdown (keys) | **holds** | 161 injections in kid hide (601 s MP4), 161 in kid panic, and 51 in parent hide (ends at `q`, as documented). Keys wrote 0 files. All five `screenshot` variants fail. |
| A3 residual (raw IPC `screenshot-to-file … video`) | **open (documented)** | Still writes the clear hidden frame. It needs the same-user socket (0700 directory). |
| A1 analyzer telemetry | **holds** | Real 6-stage scan, all 9 model files opened (including Qwen3 and whisper): 14 processes, **0** connect/sendto/sendmsg of any address family, 0 files under HOME or TMPDIR. |
| A2 Electron first launch | **holds** | Full first run with the real analyzer and 8 s of mpv playback: 39 processes, 21 AF_UNIX, 2 AF_NETLINK, **0 AF_INET/AF_INET6**. `Dictionaries/` is empty. |
| B2/B3/B4 clean copy | **holds** | 5 sources, 0 frames inside or touching a cut, 0 kept frames missing, 0 audio windows from cuts, drift ≤ 4.8 ms. |
| A6 PIN material in plaintext / deletable | **open (unchanged)** | No `safeStorage` in `desktop/main`. Not re-measured; the code is unchanged in this area. |
| A9 supply chain | **partly** | The runtime gate now blocks scans (N3). No `--hash` lock (`requirements.txt:6` "Next step (not done)"). whisper-cli `PIN_ON_FIRST_FETCH` is still present. |
| A10 minors | **mostly fixed** | `poster-clear.jpg` is now disclosed in Help (`docs/HELP/en-US.md:195`). The crash reporter is never started and dumps go to `userData/crash`; no Crashpad folder appeared in the measured first launch. The extension nonce is no longer re-announced (`bridge.js:165-170`). Still open: `library:add` accepts renderer paths (`handlers.js:170`). |
| **NEW-1** cover held 3–6 s after a skip | **new, MAJOR (fails closed)** | 3 of 8 skips in the app run: Offset MP4 #1 **3.25 s**, MKV #1 **3.25 s**, TS #2 **5.74 s** (including a 1.9 s seek overshoot). |
| **NEW-2** kid mode refuses valid MPEG-TS | **new, MAJOR (fails closed)** | Review 2's own mid-GOP DVB-like `src_mid.ts`: first frame at 1.060, so "timeline mismatch" and exit 3. Same for a TS whose audio leads video by 1.52 s. |
| **NEW-3** cover released during the kid refusal window | **new, MINOR (pre-existing)** | When kid mode refuses a broken skip file, frame 0 is uncovered 8 ms later. Within the 1.5 s before quit, SPACE plays and RIGHT shows frames uncovered. When it refuses on a timeline mismatch, Shift+RIGHT uncovers. |
| **NEW-4** forward seeks capped on offset MP4 | **new, MINOR** | RIGHT (+5) and UP (+60) move only 1.2–1.4 s on the 601 s MP4. The control file moves 5.0 s. |

---

## 1. N1 through the real app

**Script:** `scripts/n1app.js`. Raw data is in `n1-raw.json`; the analysis (`scripts/n1an.js`) is in `n1-result.json`.

**Setup:**
- Electron runs under `xvfb-run -a` and is driven by Playwright.
- `BONIS_USER_DATA` is `review4-sec/ud-n1`, with a private HOME and TMPDIR.
- `BONIS_ANALYZER` is `tools/fake-analyzer.js`, and `BONIS_PLAYER_VO` and `BONIS_PLAYER_AO` are `null`.

**Media.** A 32 s barcode source (`raw.mkv`) was encoded with x264 (`-g 48 -bf 2`) and AAC, into four files:

| file | how it was made | ffprobe `format.start_time` | video `start_time` | mpv `demuxer-start-time` | mpv first `time-pos` |
|---|---|---|---|---|---|
| Offset Six Hundred.mp4 | `-output_ts_offset 600` to TS, then `-copyts -c copy` to MP4 | **601.378** | 601.400 | 0 | **601.400** |
| Negative Start.mkv | plain MKV | **−0.021** | 0 | 0 | 0 |
| Transport One.ts | plain mpegts | **1.462** | 1.483 | 1.462 | 0.021 |
| Control Plain.mp4 | plain MP4 | 0 | 0 | 0 | 0.042 |

**Flow:**
1. Set the PIN and finish setup.
2. Call `library:add` on all four files; the fake scan runs and each title reaches `needsReview`.
3. Set range 2 of each title to `hide` with `skip:edit`.
4. Approve all ranges with `skip:approve all`. All four become `protected`.
5. Lock with `pin:lock`.
6. For each file, call `player:play {kidMode:true}` and connect a second IPC client to mpv's socket.
7. Observe `time-pos`, `user-data/bonis`, `user-data/bonis-origin` and `eof-reached` until EOF.
8. At 4 points per file (3 s, 10 s, mid-hide and 18.5 s), pause, read `time-pos`, take `screenshot-to-file … video`, decode the barcode, and resume.

**Stored start** (`library.json`): 0 / 601.378 / −0.021 / 1.462. **Published origin**: 0 / 601.378 / −0.021 / 0. Both are exactly as `player/README.md` "Timelines" states.

**Skip ranges** (fake analyzer: 20 %, 45 % and 70 % of the duration, 2 s long). The jump is the last `time-pos` before the seek and the first after it, in skip-file time (mpv clock in brackets):

| file | rfake0001 skip [6.40, 8.40) | rfake0003 skip [≈22.4, ≈24.4) | `skipped` events | first / last t |
|---|---|---|---|---|
| Control MP4 | 6.375 → 8.400 | 22.375 → 24.400 | 3/3 | 0.083 / 31.967 |
| Offset MP4 (601.378) | 6.355 → 8.400 (**607.733 → 609.778**) | 22.397 → 24.420 (623.775 → 625.798) | 3/3 | 0.105 / 31.989 |
| MKV (−0.021) | 6.354 → 8.400 (6.333 → 8.379) | 22.396 → 24.410 | 3/3 | 0.104 / 31.989 |
| TS (1.462) | 6.355 → 8.400 | 22.396 → 24.410 | 3/3 | 0.105 / 31.988 |

Every skip fires at the first frame at or after `start − 0.05` (LEAD). Round 2 measured no skip at all on the 601 s MP4.

One sample (Offset #1) has t = 8.39999 inside [6.4, 8.4). It is mpv's seek-target notification (floating point, 609.778 − 601.378), queued before the `user-data/bonis` change that bonis.lua had already made (black=true at 6.355). It is not a shown frame.

**Hide range** (rfake0002 → `hide`, [≈14.4, ≈16.4)):

| file | samples inside | uncovered | first covered sample | released at |
|---|---|---|---|---|
| Control | 48 | **0** | 14.417 (state set at 14.375 ≥ wstart) | 16.458 |
| Offset MP4 | 48 | **0** | 14.439 | 16.480 |
| MKV | 48 | **0** | 14.438 | 16.479 |
| TS | 48 | **0** | 14.438 | 16.480 |

**Content check: the frame on screen against skip-file time.**
- Method: decode the barcode of the paused frame to frame n. Its expected skip-file time is n/24 + (video start − format start). Compare that with `time-pos − origin`.
- Result: all **16/16** probes give a difference of **0 ms** (for example, Offset MP4: mpv 604.400, so t = 3.022, frame 72, so 3.022).
- During the hide range, the paused state is black and mute on all four files.

**Crash relaunch** (`scripts/crash.js`, `createPlayer` + real mpv, Offset MP4, kid mode):
- SIGKILL at t = 10.23.
- The relaunch reports its first position at 10.230, on the skip-file timeline.
- The hide range then fires at 14.4.

**Resume** (standalone, `bonis-resume=13`, Offset MP4): the first frame lands at t = 13.022 and the hide covers at 14.355.

**Parent marks** (`scripts/marks.js`, Offset MP4): `i` at mpv 603.44 and `o` at 605.44 are recorded as **2.064–4.064**, on the skip-file timeline.

**Old library entry without `start`** (`scripts/ensurestart.js`):
- Setup: real `library`, `skips` and `/usr/bin/ffprobe`, a stub player, and an HMAC-valid `library.json` written without `start`.
- Result:

  | file | `startTime` passed | persisted `start` |
  |---|---|---|
  | Offset MP4 | 601.378 | 601.378 |
  | MKV | −0.021 | −0.021 |
  | TS | 1.462 | 1.462 |
  | Control | 0 | 0 |

- Each probe took about 260 ms before mpv started.
- With ffprobe unavailable: `startTime` is undefined and nothing is persisted. Real mpv in kid mode then refuses the 601 s file: "timeline mismatch: first frame at 601.442", exit 3. **The on-the-fly probe works.**

Accepted residual: if the probe fails and the start is below 1 s (for example a 0.9 s MP4 edit list), the check passes. Ranges are then 0.9 s early, so scene tails play.

## 2. N4

- **Real app kid session** (Control MP4, during the hide range, over the mpv socket):
  - `script-message-to bonis set-kidmode 0` is accepted by mpv as a command, but `user-data/bonis.kid` stays **true** and black stays true.
  - `keypress q` afterwards: mpv is still alive.
  - `write-watch-later-config` returns `success`, but `find` over HOME, TMPDIR, userData and `player/` finds **no** watch_later path.
- **Standalone lockdown under strace** (601 s MP4, kid):
  - `mkdir(".../player/input.conf/no-watch-later") = -1 ENOTDIR`;
  - `openat(".../no-watch-later/2D58…", O_CREAT) = -1 ENOTDIR`;
  - no other write.
  - `set-kidmode 0` changed no property, and `q` did not quit.

## 3. Lockdown key set during a hide range (601 s MP4, origin 601.378)

**Script:** `scripts/lockdown.js`, which is round 2's script pointed at HEAD. Raw output is in `lk/*.json`.

**Setup:**
- mpv runs with the app's exact `buildArgs()` (`startTime` 601.378), `vo=x11` under Xvfb, and a private HOME/TMPDIR/cwd.
- strace watches `openat`, `creat`, `rename`, `unlink`, `mkdir` and `connect`.
- Hide range [10, 20); the kid run resumes at 11 and pauses at t = 13.4.
- 161 items are injected: the 5 screenshot commands, 3 `screenshot-to-file`, the 128 default mpv bindings plus bonis extras, and raw IPC commands.

**Results:**
- **Kid hide:** the process survived all 161 items.
  - The only state changes come from the documented bonis keys: seeks are intercepted, plus `f`, ENTER and double click, ESC, `9`/`0`, `p` and Ctrl+SPACE.
  - RIGHT (inside the range) stayed inside and covered. LEFT and DOWN left the range backwards (uncovered, allowed). UP and Shift+PGUP landed inside the range and were covered.
  - Keys created **0** files. All five `screenshot …` commands fail (`mkdir …/input.conf/no-screenshots` gives ENOTDIR).
- **Kid panic:** same result; 0 files, and no quit.
- **Parent hide:** `q` quits, as documented.
- **Raw IPC residual (A3, documented):** `screenshot-to-file … video/subtitles` writes the clear frame (average RGB 86,76,77, the hidden noise frame). The `window` mode gives 2,0,3 (black).
- `osd-level 0` and `sub-visibility yes` are accepted. The cover survives, as in round 2.

## 4. Integrity gate

**Script:** `scripts/integ.js`. Raw output is in `integ-result.json`.

**Setup:** a temporary resources tree holds:
- the real `models/manifest.json` (19 entries; models symlinked to `scratchpad/models`, and `yamnet.onnx` copied);
- `player/bonis.lua` with a `player.lock.json`.

The app is launched with `BONIS_VERIFY_RESOURCES` pointing at that tree.

- **A. 4096 bytes flipped at offset 1 MiB of `models/yamnet.onnx`:**
  - Integrity result after 4.7 s: `{checked:19, damaged:[models/yamnet.onnx: mismatch]}`.
  - The added title goes straight to `needsAttention`, error `bundleDamaged`; Try again (`scan:queue`) still gives `bundleDamaged`.
  - The message names the file:
    - banner: "Needs attention: a bundled file is damaged. **models/yamnet.onnx** does not match the copy that came with bonis oculis. Install bonis oculis again.";
    - toast: the same text;
    - card: "A file that came with bonis oculis is damaged, so scanning is stopped…".
  - `app:checkFiles` reports the same file.
- **B. `bonis.lua` damaged (bytes appended):**
  - Result: `damaged:[player/bonis.lua: size]`.
  - Parent play gives **`bundleDamaged`**; kid play gives **`kidRefused`**. `player:status` is idle and `pgrep mpv` is empty, so mpv never starts.
  - Note: in a dev run the gate checks the tree copy, while mpv runs `player/bonis.lua` from the repo. In a packaged build both are `resources/player/bonis.lua`.
- **C. Damage after a clean first check (residual N3):**
  1. First launch: `{checked:19, damaged:[]}`.
  2. Close, flip 4 KB of yamnet, relaunch and unlock.
  3. No integrity event fires. The title **scans to `needsReview` with the damaged model**.
  4. Only the manual "Check installed files" finds it; after that, scans are refused.
  5. Also, in a packaged build the first check starts 15 s after launch (`main.js:235`), so a resumed queue scans before the gate exists.

## 5. Clean copy (real `cleanCopy()`, libx264, 2 threads; barcode and audio verifier from round 2)

Cuts are on the skip-file timeline (pts − format start), which is now also the player's timeline.

| source | start | cuts | frames in → out | inside / touching cut | kept frames missing | unknown / dup / non-mono | audio leaked (20 ms windows) | drift max |
|---|---|---|---|---|---|---|---|---|
| Offset Six Hundred.mp4 (32 s) | 601.378 | [6.4,8.4] [14.41,16.41] [22.42,24.42] | 768 → 621 | **0 / 0** | 0 | 0/0/0 | 0 | 0.4 ms |
| Negative Start.mkv (32 s) | −0.021 | [6.4,8.4] [14.41,16.41] [22.41,24.41] | 768 → 621 | **0 / 0** | 0 | 0/0/0 | 0 | 0.2 ms |
| rec600.mp4 (60 s, round 2) | 601.4 | [10.3,14.7] [30.2,31.1] | 1440 → 1311 | **0 / 0** | 0 | 0/0/0 | 0 | 0.4 ms |
| src_h264.mkv (60 s, AAC + AC3, round 2) | −0.021 | 3 cuts | 1440 → 1269 | **0 / 0** | 0 | 0/0/0 | 0 / 0 | 4.8 ms |
| rec600.mkv (60 s, round 2; failed in round 2, N2) | 601.4 | [10.3,14.7] | 1440 → 1333 | **0 / 0** | 0 | 0/0/0 | 0 / 0 | 0.0 ms |

Round 2's leaks on the mpv timeline (1 frame on MKV, 54 frames on MP4 at 1.4 s) no longer apply: marks and enforcement now use the same timeline as the copy (§1, parent marks).

## 6. Privacy

- **Real-model scan** (`scripts/a1scan.sh`):
  - **Command and environment:** `env -i` with a private HOME and TMPDIR, `PYTHONUSERBASE=/root/.local` (for jinja2), and `BONIS_MODELS_DIR=scratchpad/models`. The run is `strace -f -e connect,sendto,sendmsg,openat,…` over `python3 -m bonis_analyzer.cli scan --force-speech --profile`, on a 32 s clip with a sidecar SRT so the LM loads.
  - **Exit:** 0 after 3 min 36 s.
  - **Models opened:** nsfw-vit-int8, clip-vision, florence2 ×4, yamnet, whisper-small and qwen3-0.6b (LM stage 6.4 s, 984 MB).
  - **Network:** 14 traced processes; **0 connect, 0 sendto, 0 sendmsg** of any address family.
  - **Files:** 0 files created under HOME or TMPDIR.
  - A first run without `PYTHONUSERBASE` had not loaded the LM; it also gave 0/0/0.
- **Electron first launch** (`scripts/drv-real.js`):
  - **Setup:** empty userData, private HOME and TMPDIR. The run uses the UI wizard (language, PIN twice, code, levels), adds a movie, and runs the **real analyzer with real models**. It then opens Help and About, plays in mpv for 8 s (`mpv spawned`, `ipc connected` and `exited code=0` in the log), and quits.
  - **Network:** 39 processes; connect families: 21 AF_UNIX, 2 AF_NETLINK, **0 AF_INET/AF_INET6**.
  - **Files:** `Dictionaries/` is empty and there is no Crashpad folder. mpv creates an empty `~/.config/mpv/` directory, which is harmless.
- Repo suites run read-only into scratch (`timeline`, `lockdown`, `bonis-lua`, `player-service`, `integrity`, `probe`, `clean-copy`): 46/46 pass.

---

## NEW findings

### NEW-1. MAJOR (video, fails closed): the cover stays black and muted for 3–6 s after a skip whenever the landing frame is not exactly where bonis.lua expects
- **Where:** `player/bonis.lua`.
  - `seek_to` has SEEK_GUARD (lines 457-466).
  - The `playback-restart` own-seek check is at lines 628-636.
  - The stale-cover watchdog is at lines 642-651.
- **Mechanism, two triggers:**
  - **(a) The landing frame is still inside the range.** An `absolute+exact` seek to `r.stop` shows a frame up to ~5 ms *before* the target (mpv hr-seek tolerance).
    - Measured with a debug log: restart at t = **8.397** for target 8.4 on the 601 s MP4.
    - That t is still inside [wstart, stop), so `evaluate` wants to skip again. `seek_to` refuses the identical target (SEEK_GUARD), but `skip_pending = true` and black are already applied.
    - Nothing clears them until the 3 s watchdog.
    - This is not specific to non-zero origins. On the control MP4 with a range ending at 8.377 (frame at 8.375), the cover is held 3.6 s.
  - **(b) The landing is more than 0.1 s from the target.** On MPEG-TS, mpv overshot an exact seek: 24.41 became **26.31**. `playback-restart` treats it as "not ours yet" and sets `in_seek = true`, so all ticks are ignored until the watchdog.
- **Measured in the real-app run:** 3 of 8 skips.
  - Offset MP4 #1: black and mute from 8.40 to **11.65** (3.25 s of innocent content).
  - MKV #1: 8.40 to 11.65 (3.25 s).
  - TS #2: 24.41 to **30.15** (5.74 s: 1.9 s over-skipped, then 3.8 s black).
  - Unaffected skips release within 0.06–0.12 s.
  - The paused probe at t = 10.02 on the Offset MP4 and the MKV reads black=true, outside any range.
- **Impact:** the frequency is roughly (hr-seek tolerance) / (frame duration) per skip, plus every TS overshoot. The kid sees 3–6 s of black and silence after a large share of skips. Nothing leaks.
- **Fix:**
  1. Seek to `stop + one frame`, or treat `t ≥ stop − frame/2` as outside for skip ranges.
  2. In the restart check, accept any landing `t ≥ own_seek.target − 0.05` as ours, so an overshoot counts.
  3. When SEEK_GUARD suppresses a re-seek, clear `skip_pending` instead of keeping the cover.
- **Test:** add one that asserts the cover is released ≤ 0.2 s after landing, on a frame grid offset by 0.003 s and on a TS.

### NEW-2. MAJOR (video, fails closed): the N1 first-frame check refuses valid MPEG-TS whose first shown frame is more than 1 s after `format.start_time`
- **Where:** `bonis.lua` `check_origin` (lines 1040-1054). `expected_first` is 0, and the tolerance is 1 s.
- **Repro** (standalone, app `buildArgs`, kid mode, correct probed start):
  - Round 2's **mid-GOP DVB-like `src_mid.ts`** (format start 1.4027, video 1.463, first decodable frame later): "timeline mismatch: first frame at 1.060, expected 0.000 (origin 0.000)", kid refused (exit 3).
  - A TS whose audio leads video by 1.52 s: "first frame at 1.521", refused.
  - Both files have a correct origin; the check is a false alarm.
- **Impact in the app:**
  - The title is Protected and shows on the kids' screen, but every play ends with the generic "cannot play" toast. The `timeline` error code maps to no message (`player-service.js:184-186`).
  - Parent mode shows "This file's clock does not match its protection list" although it does match.
  - Recordings cut mid-GOP, the common DVB case, are exactly this class.
- **Fix:**
  1. Probe the first video frame (video stream `start_time`, or the first keyframe pts) at library add.
  2. Set `expected_first` to that value minus the format start.
  3. Alternatively, apply the strict 1 s check only when the start is unknown. When the start is probed, verify `demuxer-start-time` against it instead of the first frame.
- **Test:** add `src_mid.ts`-style and audio-leads fixtures to `timeline.test.js`.

### NEW-3. MINOR (security, defence in depth; pre-existing, present in `7081f56` too): the kid-mode refusal window does not keep the cover
- **Where:** `fail_closed` (`bonis.lua:679-688`) sets `closing`, pauses and covers, then quits after 1.5 s. But `apply()` and `evaluate()` ignore `closing`.
- **Repro** (`scripts/failload.js`, `scripts/failwin.js`):
  - **Invalid skip file in kid mode:** `user-data/bonis.black` goes true, then **false 8 ms later** at t = 0, from the restart evaluation with no ranges. Frame 0 sits uncovered for 1.5 s.
    - SPACE: the video **plays uncovered** from 0.04 to 0.92.
    - RIGHT ×3: paused, uncovered frames at 5, 10 and 15 s.
    - The same happens with `7081f56`'s bonis.lua.
  - **Timeline-mismatch refusal:** RIGHT, SPACE and PGUP keep the cover, but **Shift+RIGHT releases it** (restart, then evaluate).
- **Reach:** low. The app pre-validates kid playability and writes the play file itself, so the load-failure path needs a same-user process to break the play file. It is still the script's last line of defence, and it fails open there.
- **Fix:**
  1. `if closing then want = {black=true, mute=true} end` at the top of `apply`, and return early from `evaluate` while closing.
  2. Unbind the seek and pause keys in `fail_closed`.

### NEW-4. MINOR (video): forward seeks on MP4/MOV with a start offset are capped at mpv's read-ahead edge
- **Where:** `safe_target` (`bonis.lua:799-810`) uses mpv `duration − origin` as the end.
- **Cause:** for an MP4 whose packets start at 601.4, mpv 0.37 raises `duration` to the highest pts read so far: 602.6, 603.7, 604.7… up to 633.4 only once fully cached. Measured.
- **Effect:** RIGHT (+5) moves **1.2–1.4 s**, and UP (+60) and Shift+PGUP (+600) do the same, in both modes. The control MP4 moves 5.0 s.
- **Safety:** none lost. When the clamped target lands inside a range, the seek-event evaluation still covers or skips (lockdown: UP into the hide range was covered).
- **Fix:** pass the probed duration (`bonis-duration`) and clamp to it.

### Observations, not findings
- `evaluate_inner(t, origin)` shadows the module-level `origin` with the event-kind string. It is harmless today, because nothing inside uses the number, but it is a trap for the next edit.

---

## Verdicts

**Privacy and security auditor: PASS, with conditions (no blockers).**
- **N4: closed.** `set-kidmode` is one-way in the real app, and watch-later writes nothing (strace: ENOTDIR only).
- **A1 and A2 re-proved:** 0 IP sockets in a real-model scan (all 9 models, LM included) and in a full first launch with the real analyzer and mpv.
- **Lockdown holds:** 0 files from 161 keys in kid hide and kid panic.
- **N3: gate works.** Scans are refused with the file named, and a damaged `bonis.lua` stops the player in both modes.
- **Must close before release (non-blocking):**
  - N3 remainder: the check runs once per version, so a file damaged after the first check is scanned with (measured, C). The packaged check starts 15 s after launch, and the analyzer does no per-stage hash check.
  - A6, unchanged: no `safeStorage`; deletable or forgeable PIN material.
  - A9: no hash lock, and whisper-cli pins are unresolved.
  - A10: `library:add` accepts renderer paths.
  - A3 IPC residual: documented.
  - NEW-3: make the refusal window keep the cover.

**Senior mpv/VLC video engineer: PASS, with conditions (no blockers).** Round 2's blocker N1 is closed, end to end through the real app:
- MP4 at 601.378 s, MKV at −0.021 s, TS at 1.462 s and the control all skip at the right skip-file times, and the hide range is covered (0 uncovered of 192 samples);
- the frame on screen matches skip-file time to 0 ms;
- crash relaunch, resume and parent marks are on the same timeline;
- old library entries are probed on the fly;
- N2 is closed;
- the clean copy leaks 0 frames and 0 audio on the 601 s MP4, the MKV and three round-2 sources.

**Must fix before release (both fail closed, no leak):**
- **NEW-1:** 3–6 s of black and silence after about a third of skips in this run.
- **NEW-2:** valid mid-GOP or audio-leading TS recordings cannot play in kid mode at all.

**Minor:** NEW-4.

Scripts and raw outputs:
- `scratchpad/review4-sec/scripts/`: `n1app.js`, `n1an.js`, `ensurestart.js`, `standalone.js`, `mkdoc.js`, `failwin.js`, `failload.js`, `failload2.js`, `seekcap.js`, `crash.js`, `marks.js`, `lockdown.js`, `integ.js`, `ccdrive.js`, `a1scan.sh`, `drv-real.js`;
- results: `n1-raw.json`, `n1-result.json`, `integ-result.json`, `lk/*.json`, `cc/ver-*.json`, `a1-sys129b/strace.log`, `a2full/conn.log`, `sa-*/mpv.log`.
