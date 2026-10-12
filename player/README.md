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

The app passes each option as its own `--script-opts-append` so paths containing commas survive
(`--script-opts=a=1,b=2` would split them).

## What is enforced

Ranges with `review` other than `rejected` and `action` other than `none`, shifted by
`media.offset`. A range is active from `start - 0.05 s` (the blur filter is armed 0.5 s earlier
because adding a filter re-initialises the video chain) until `end` (exclusive).

| action | effect | restored |
|---|---|---|
| `skip` | screen covered + muted, `seek <end> absolute+exact`, OSD "Scene skipped" | when playback restarts outside |
| `hide` | full-window black ASS overlay + `mute=yes` + subtitles hidden | at `end` |
| `blur` | `vf add @bo-blur:lavfi=[scale=iw/24:-2:flags=area,scale=iw*24:-2:flags=neighbor]` + mute | at `end` (filter removed) |
| `mute` | `mute=yes` | at `end` |

- Enforcement runs on every `time-pos` change, on the `seek` event (at that moment `time-pos`
  already holds the seek target, so a seek into a skip range is re-targeted before a single frame
  of it is decoded) and on `playback-restart`.
- Backward seeks landing in a range: parent mode → `start - 1 s`; kid mode → the range end.
- Forward seeks landing in a skip range go to its end; into hide/mute/blur ranges the effect
  applies at once.
- Seek-loop guard: the script never re-issues a seek to the same target within 0.3 s.
- Blur watchdog: if `frame-drop-count` grows by more than 5 while blurring, or the filter cannot be
  added, the filter is removed and blur becomes hide for the rest of the session.
- Mute and subtitle visibility are restored to exactly what they were before the range; if
  something unmutes during a range, the script mutes again. On `end-file` everything is released.
- Starting (or resuming after a crash) inside a range: the screen is covered from the first frame.
- Overlapping ranges combine: skip wins; otherwise black if any hide, mute if any range mutes.
- Lookup is O(log n): ranges sorted by start with a prefix maximum of ends.

## Keys

| key | mode | effect |
|---|---|---|
| `i` | parent | Mark in at the current time. OSD "Mark set at 00:01:23". |
| `o` | parent | Mark out: creates a range (`category other`, `source manual`, `review pending`, `action skip`, `confidence 1`), appends it to the marks file, sends `mark`. |
| `u` | parent | Undo: drops a pending mark-in, else the last completed mark (writes and sends `undo`). |
| `p` / `Ctrl+Space` | both | Panic phase 1: black + mute at once. Phase 2 (same key again, or `Enter`): restore, save the range `[pressed - leadin, now]`, `source panic`, `review approved`, `action skip`. The range is also enforced for the rest of the session. |
| `→` | while panic-hidden | Seek +10 s without OSD. |

In kid mode `i`/`o`/`u` show "Not available in kid mode" and do nothing. Mark times are written in
the skip file's own timeline (`media.offset` subtracted), with 3 decimals.

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
| `{"t":"error","code":"skipfile"\|"kid-refused"\|"reload","msg":"…"}` | load or reload failure |

The marks file is append-only JSON lines in exactly these shapes (`mark`, `undo`, `panic` end); each
line is written, flushed and closed before the message is sent, so nothing is lost if the app is
gone. The app merges it into the skip file.

## Messages from the app (`script-message-to bonis …`)

- `reload <path>` — load another skip file (keeps the previous list if the new one is invalid; in
  kid mode with nothing valid loaded, fails closed).
- `set-kidmode 0|1` — switch modes; switching to kid mode with no valid file fails closed.
- `hello` — re-sends `ready` (and the last load error), for an app that connected late.

State for tests and the app is also published as the mpv property `user-data/bonis`
(`{black, mute, blur, panic, kid, loaded, enforced}`).

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
`--vo=null --ao=null --no-config --speed=10` and a generated 60 s colour-bar video in
`$BONIS_TEST_DIR` (default `<tmpdir>/bonis-oculis-test`). `BONIS_MPV` / `BONIS_FFMPEG` override the
binaries (default `/usr/bin/mpv`, `/usr/bin/ffmpeg`); without them the tests are skipped.
