# player/ — mpv script `bonis.lua`

`bonis.lua` runs inside mpv (0.37+, Lua 5.1/5.2). It reads a bonis oculis skip file
(`spec/SKIPFILE.md`) and obeys it while the movie plays. It never detects anything: the skip file
is the contract. It has no network code. The desktop app starts mpv through
`desktop/main/player-controller.js`; plain mpv users can load the script by hand:

```
mpv --script=player/bonis.lua \
    --script-opts-append=bonis-skipfile=/movies/Film.bonis.json \
    --script-opts-append=bonis-marks=/movies/Film.bonis.marks.jsonl \
    /movies/Film.mkv
```

## Options (`--script-opts-append=bonis-<name>=<value>`)

| option | default | meaning |
|---|---|---|
| `skipfile` | (empty) | Path of the `.bonis.json` skip file. |
| `marks` | (empty) | JSON-lines file that every mark, undo and panic range is appended to. Empty = not written. |
| `kidmode` | `0` | `1` = kid mode: marking keys off, seeks cannot enter ranges, fail closed. |
| `lang` | `en` | OSD language: `en` or `es` (anything starting with `es`). |
| `panickey` | `p` | Panic key. `Ctrl+Space` always works too. |
| `markin` / `markout` / `undo` | `i` / `o` / `u` | Marking keys (parent mode only). |
| `leadin` | `2` | Seconds the panic range starts before the moment the key was pressed. |
| `start` | (empty) | The media's probed `format.start_time` (ffprobe), i.e. where skip-file time 0 is. Empty = unknown. |
| `duration` | (empty) | Probed duration on the skip-file timeline, for clamping seek keys (mpv's own `duration` grows as it reads an MP4 with a start offset). Empty = mpv's. |
| `resume` | (empty) | Start playback here, in skip-file time (the app never uses mpv's `--start`, which is on mpv's clock). |

The app passes each option as its own `--script-opts-append` so paths containing commas survive
(`--script-opts=a=1,b=2` would split them).

## Timelines (board review 2, N1)

A skip file counts seconds from the media's probed `format.start_time`, as ffmpeg/ffprobe, the
analyzer and the clean copy do. mpv's `time-pos` does not always: it keeps absolute timestamps for
MP4/MOV with an edit list and for MKV with a negative start, and rebases MPEG-TS. When the file
opens (`on_preloaded` hook), the script computes

    origin = bonis-start - demuxer-start-time        (0 when bonis-start is unknown)

and works in skip-file time everywhere: it subtracts `origin` from every `time-pos` it reads and
adds it to every seek target, the resume position, `duration` and chapter times. Marks, panic
ranges, OSD times and the controller's `timepos` events are all in skip-file time. `origin` is
published as `user-data/bonis-origin`.

Measured with mpv 0.37 on the test fixtures (`test/timeline.test.js`):

| fixture | ffprobe start | mpv `demuxer-start-time` | origin |
|---|---|---|---|
| MP4 remuxed with `-copyts` from a TS starting at 601.4 s | 601.378 | 0 | 601.378 |
| MKV, x264 B-frames + AAC priming | −0.021 | 0 | −0.021 |
| MPEG-TS starting at 1.4 s | 1.379 | 1.379 | 0 |
| plain MP4 | 0 | 0 | 0 |

Check: the first frame must land where it should (0, or the resume point): within
[−1 s, +3 s] when `start` was probed (an MPEG-TS cut mid-GOP or with audio leading video shows
its first frame 1–1.5 s in), within ±1 s when it is unknown. If it does not, kid mode refuses to
play (`error` with code `timeline`, then exit 3) and parent mode shows a warning and goes on. Kid
mode stays covered from before the first frame until this check has passed.

During any kid-mode refusal (bad skip file, timeline mismatch) the player stays black and muted
and every key is dead until mpv has quit 1.5 s later.

## What is enforced

Ranges with `review` other than `rejected` and `action` other than `none`, shifted by
`media.offset`. A range is active from `start - 0.05 s` (the blur filter is armed 0.5 s earlier
because adding a filter re-initialises the video chain) until `end` (exclusive).

| action | effect | restored |
|---|---|---|
| `skip` | screen covered + muted, `seek <end + 0.05 s> absolute+exact`, OSD "Scene skipped" + the panic hint (2 s) | when playback restarts outside |
| `hide` | full-window black ASS overlay with a small grey "Hidden" / "Oculto" label + `mute=yes` + subtitles hidden | at `end` |
| `blur` | `vf add @bo-blur:lavfi=[scale=iw/24:-2:flags=area,scale=iw*24:-2:flags=neighbor]` + mute, both from `start - 0.5 s` | at `end` (filter removed) |
| `mute` | `mute=yes` | at `end` |

- Enforcement runs on every `time-pos` change, on the `seek` event (at that moment `time-pos`
  already holds the seek target, so a seek into a skip range is re-targeted before a single frame
  of it is decoded) and on `playback-restart`.
- Seek keys are intercepted before mpv seeks (both modes): the script computes the target and, if
  it falls inside an enforced range, asks mpv for the range end (forward) or `start - 1 s`
  (backward) instead, with `absolute+exact`. No keyboard seek lands inside a range.
- Post-hoc rules (the safety net, for seeks the script cannot intercept: IPC, other scripts):
  backward seeks landing in a range go to `start - 1 s` in parent mode and to the range end in
  kid mode.
- Forward seeks landing in a skip range go to its end; into hide/mute/blur ranges the effect
  applies at once.
- Seek-loop guard: the script never re-issues a seek to the same target within 0.3 s.
- Skip landings: mpv's exact seek may show the frame up to ~5 ms *before* its target, so skips
  (and intercepted forward seeks) target the range end + 0.05 s. Any landing at or after
  target − 0.01 s counts as ours, including overshoots (MPEG-TS can land seconds later), and
  lifts the cover and mute at once. A landing a hair before the end right after our own skip seek
  is also released. Measured: 8–12 ms from the landing frame to the cover lifting.
- Blur watchdog: if `frame-drop-count` grows by more than 5 while blurring, or the filter cannot be
  added, the filter is removed and blur becomes hide for the rest of the session.
- Mute and subtitle visibility are restored to exactly what they were before the range; if
  something unmutes during a range, the script mutes again. On `end-file` everything is released.
- Starting (or resuming after a crash) inside a range: the screen is covered from the first frame.
- Overlapping ranges combine: skip wins; otherwise black if any hide, mute if any range mutes.
- Lookup is O(log n): ranges sorted by start with a prefix maximum of ends.

## Locked-down launch and keys

The app starts mpv so that **only the keys below do anything** (`desktop/main/player-controller.js`):
`--input-default-bindings=no --input-conf=player/input.conf` (an intentionally empty file)
`--no-input-terminal --osc=no --load-scripts=no --load-osd-console=no --load-stats-overlay=no`
`--load-auto-profiles=no --ytdl=no --screenshot-directory=<player/input.conf>/no-screenshots`
`--watch-later-dir=<player/input.conf>/no-watch-later --write-filename-in-watch-later-config=no`
`--no-save-position-on-quit --no-resume-playback` (no resume file is ever written or read, even by
an IPC `write-watch-later-config`; the app resumes by itself with `bonis-resume`),
(a directory under a regular file can never be created, so every `screenshot` command fails), and
the IPC socket in a fresh 0700 directory. `--load-scripts=no` alone does not stop mpv's bundled
console and stats scripts; the two `--load-*` flags do.

| key | mode | effect |
|---|---|---|
| `SPACE` | both | Pause / play. |
| `←` `→` / `↑` `↓` | both | Seek ∓5 s / ±60 s (intercepted, see above). |
| `Shift+←` `Shift+→` / `Shift+↑` `Shift+↓` | both | Seek ∓1 s / ±5 s (intercepted). |
| `PGUP` / `PGDWN` | both | Next / previous chapter (intercepted; nothing without chapters). |
| `Shift+PGUP` / `Shift+PGDWN` | both | Seek ±10 min (intercepted). |
| `f`, `ENTER`, double click | both | Toggle fullscreen (`ENTER` ends panic while hidden). |
| `m` | both | Mute toggle. Inside a range the range keeps the sound off; the key changes what is restored when the range ends (OSD says so). |
| `9` / `0` | both | Volume −2 / +2. |
| `ESC` | both | Leave fullscreen. When windowed: quit (parent), nothing (kid). |
| `q`, window close button | parent | Quit. In kid mode nothing: only the app can stop playback. |
| `i` | parent | Mark in at the current time. OSD "Mark set at 00:01:23". |
| `o` | parent | Mark out: creates a range (`category other`, `source manual`, `review pending`, `action skip`, `confidence 1`), appends it to the marks file, sends `mark`. |
| `u` | parent | Undo: drops a pending mark-in, else the last completed mark (writes and sends `undo`). |
| `p` / `Ctrl+Space` | both | Panic phase 1: black + mute at once. Phase 2 (same key again, or `Enter`): restore, save the range `[pressed - leadin, now]`, `source panic`, `review approved`, `action skip`. The range is also enforced for the rest of the session. |
| `→` | while panic-hidden | Seek +10 s without OSD (jumps past any enforced range it would land in). |

Everything else does nothing, including mpv's screenshot keys (`s`, `S`, `Ctrl+s`, `Alt+s`), the
console (`` ` ``), stats (`I`), track, speed, zoom, colour, subtitle, loop, playlist and quit-variant
keys, wheel and media keys. `test/lockdown.test.js` injects all of them over IPC inside a hide range
and inside a panic cover and checks that no property, file or process changes.

In kid mode `i`/`o`/`u` show "Not available in kid mode" and do nothing. Mark times are written in
the skip file's own timeline (`media.offset` subtracted), with 3 decimals.

At every file start the OSD shows "Press P to hide the picture at once" / "Presiona P para ocultar
la imagen" (one language, from `lang`) for 4 s, and again for 2 s with "Scene skipped" after every
automatic skip. The last OSD text is mirrored in the property `user-data/bonis-osd`.

### Residual risk: `screenshot-to-file` and `screenshot-raw`

The black cover is an OSD overlay, so the decoded frame underneath is the real picture. The
`screenshot` command always fails (see above), but mpv cannot disable the IPC commands
`screenshot-to-file <path>` and `screenshot-raw`: they write or return the real frame. They are
reachable only through the IPC socket, which sits in a 0700 directory owned by the user who runs
the app. Anything that can use that socket runs as the same user and can read the movie file itself,
so this is not an escalation, but it means a cover is not a guarantee against software on the same
account.

## Messages to the app

Sent with `script-message bonis <json>`; IPC clients receive them as
`{"event":"client-message","args":["bonis","<json>"]}`.

| message | when |
|---|---|
| `{"t":"ready","seq":1,"ranges":6,"enforced":4,"kid":false,"loaded":true}` | after each (re)load; `seq` increases per load |
| `{"t":"skipped","rangeId":"r…","action":"skip"}` | each time playback enters a range |
| `{"t":"mark","range":{…}}` | a mark was completed (same line is in the marks file) |
| `{"t":"undo","id":"r…"}` | the last mark was undone (same line is in the marks file) |
| `{"t":"panic","phase":"start","at":12.3}` | panic phase 1 |
| `{"t":"panic","phase":"end","at":20.1,"range":{…}}` | panic phase 2 (same line is in the marks file) |
| `{"t":"error","code":"skipfile"\|"kid-refused"\|"reload"\|"timeline","msg":"…"}` | load or reload failure; timeline mismatch |

The marks file is append-only JSON lines in exactly these shapes (`mark`, `undo`, `panic` end); each
line is written, flushed and closed before the message is sent, so nothing is lost if the app is
gone. The app merges it into the skip file.

## Messages from the app (`script-message-to bonis …`)

- `reload <path>` — load another skip file (keeps the previous list if the new one is invalid; in
  kid mode with nothing valid loaded, fails closed).
- `set-kidmode 1` — lock the session into kid mode (with no valid file it fails closed). One way
  only: `set-kidmode 0` (or anything else) is ignored; to leave kid mode the app stops the player.
- `hello` — re-sends `ready` and any load or timeline error, for an app that connected late.

State for tests and the app is also published as the mpv property `user-data/bonis`
(`{black, mute, blur, panic, kid, loaded, enforced, at}`, where `at` is the playback position at
which the change took effect).

## Failure modes

| situation | parent mode | kid mode |
|---|---|---|
| skip file missing, unreadable, invalid JSON, wrong `format`, `version` ≠ 1, a malformed range | OSD warning for 5 s, plays **unprotected**, sends `error` | paused + black + muted, OSD "not ready for kid mode", `error` sent, `quit 3` after 1.5 s |
| `scan.status` = `none` | plays (ranges, if any, enforced) | refuses as above |
| marks file not writable | OSD "Could not save the mark", message still sent | same |
| blur too slow / filter fails | falls back to hide | same |
| mpv crashes | the controller relaunches once at the last position; a second crash within 60 s stops | same |

Exit code `3` means "refused in kid mode"; the controller does not relaunch on it.

## Tests

`npm run test:player` runs `player/test/*.test.js` against real mpv and ffmpeg with
`--vo=null --ao=null --no-config --speed=4` and a generated 60 s colour-bar video in
`$BONIS_TEST_DIR` (default `<tmpdir>/bonis-oculis-test`). `BONIS_MPV` / `BONIS_FFMPEG` override the
binaries (default `/usr/bin/mpv`, `/usr/bin/ffmpeg`); without them the tests are skipped.
`overlay-x11.test.js` additionally runs mpv in a real X11 window under `xvfb-run -a` (`--vo=x11`,
falling back to `--vo=gpu`) and measures the screen with ffmpeg `x11grab`: mean luminance must be
below 8 during a hide range and above 40 after it. It is skipped when `xvfb-run` or `x11grab` is
missing.
