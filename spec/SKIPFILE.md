# bonis oculis skip file — specification v1

One JSON document per movie. File name: `<movie basename>.bonis.json`, stored next to the movie
when the folder is writable, and always inside the app library (`<userData>/library/<oshash>.bonis.json`).
The library copy is authoritative; the sidecar is a convenience for other players and for sharing.

The JSON Schema in `skipfile.schema.json` is the source of truth. Every reader (desktop app, Lua
player script, Python analyzer, browser extension) must validate against the same fixtures in
`fixtures/`. A reader must accept unknown top-level keys from a *higher* version and refuse a
different `format` string.

## Time model
- `start`/`end` are seconds in the timeline of the media the scan ran on. `end` is exclusive and
  must be greater than `start`. Ranges must not overlap after fusion (they may before review).
- `media.offset` is added to every `start` and `end` when applying the file to a media file whose
  fingerprint does not match (another edition). Default 0.
- Lead-in padding is already included in `start`. Players do not add their own padding.

## Fingerprint
- `oshash`: OpenSubtitles algorithm. `size` + sum of the first 64 KiB and last 64 KiB read as
  little-endian uint64 words, modulo 2^64, as 16 hex characters. Cheap for 20 GB files.
- `headSha256`: SHA-256 of the first 1 MiB. Used to detect byte-identical heads with different
  tails (a truncated copy).
- `sceneCuts`: sorted list of scene-cut timestamps. Used to auto-compute `offset` for other
  editions by correlating cut patterns.

Matching rules, in order: exact `oshash` + `size` → match (offset 0). Same `headSha256` → match,
warn. Otherwise ask the parent to pick a file and compute offset from scene cuts when available.

## Categories
`nudity`, `sex` (sexual activity without nudity), `implied` (off-screen or suggested), `kissing`
(heavy), `gore`, `language` (profanity; optional, default level off), `other` (manual marks with
no category chosen yet).

## Actions
`skip`, `hide` (black + mute), `blur` (pixelate + mute; best effort, falls back to hide),
`mute` (audio only), `none`. The analyzer writes a default action from the levels in force; a
parent's edit sets `locked: true` and survives rescans.

## Review states
`pending` (auto, not yet reviewed), `approved`, `rejected`. Players enforce `pending` and
`approved` ranges whose action is not `none`. `rejected` ranges are kept (so a rescan does not
re-create them) but never enforced.

Kid mode is fail-closed: if the file is missing, fails validation, or `scan.status` is `none`,
the player refuses to play in kid mode and tells the parent why.

## Notes
`note` is a short, non-graphic sentence for the review screen and the parents card. It is
generated from templates by signal type ("Nudity detected in the picture; dialogue suggests
intimacy."), never copied from captions or dialogue.

## Levels → thresholds (defaults, tuned to catch too much)
| level | min confidence to enforce | default action |
|---|---|---|
| off | never | none |
| light | 0.80 | skip |
| moderate | 0.60 | skip |
| strict | 0.40 | skip |
`language` defaults to `mute` at every level. Presets: "Little kids" = strict everywhere;
"Teens" = moderate nudity/sex/gore, light implied/kissing, language off.

## Kodi EDL export
One line per enforced range: `start end action` with action `0` (cut) for skip/hide/blur and `1`
(mute) for mute. Times include `media.offset`. Written as `<movie basename>.edl` next to the movie.

## mpv segment EDL export (plain-mpv users only)
`# mpv EDL v0` header, then one `path,start,length` line per *kept* segment. Our own player does
not use it; it reads the JSON directly.
