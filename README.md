# bonis oculis

*"With good eyes."* A desktop app for families that scans a movie once, offline, writes a list of
scenes to skip, and lets a player obey that list. Sexual content and gore are skipped, hidden or
muted at playback; nothing is detected while a movie plays, and nothing leaves the computer.

Three pieces share one skip-file format (`spec/SKIPFILE.md`):

| Piece | Folder | What it does |
|---|---|---|
| Desktop app (Windows 10/11, macOS) | `desktop/`, `player/`, `analyzer/` | Library, offline analyzer, review without watching, mpv-based player, PIN, kid mode, exports (skip file, Kodi EDL, exact clean copy for USB/TV) |
| Browser extension (Chrome/Brave, MV3) | `extension/` | Subtitle pre-read, user subtitle files, skip-file import, panic key, cover + mute on DRM sites, experimental live tab-audio |
| TV paths | in-app Help | Fire TV: VLC + clean copy on USB (simple) or Kodi + `.edl` (advanced) |

Languages: Spanish (MX) and English (US). Everything is local: no accounts, no telemetry, no
network code. The privacy claim is enforced by tests that trace sockets during a real scan and a
full first launch.

## Status

Feature-complete prototype, reviewed by a simulated board (see `docs/reviews/`). Windows and
macOS installers are produced by the GitHub Actions workflow; no installer has been built or run
on real Windows or macOS hardware yet, and detector accuracy has not been measured on real films
(the app ships a "Check accuracy" screen for that, see brief rule 6.5). Read `docs/LEDGER.md`
for the honest findings and open items.

## Repository map

- `docs/BRIEF.md` — the owner's specification. `docs/PLAN.md` — binding architecture.
  `docs/DESIGN.md` — design system. `docs/LEDGER.md` — progress, decisions, honest findings.
- `spec/` — skip-file JSON schema, fixtures, shared lexicons.
- `shared/` — ES5 skip-file library and subtitle scanner used by the app and the extension.
- `desktop/` — Electron app (main process in CommonJS ES5, renderer in IIFE ES5, no bundler).
- `player/` — `bonis.lua`, the mpv script that enforces the skip file.
- `analyzer/` — Python analyzer (ONNX Runtime, llama.cpp, whisper.cpp; no PyTorch).
- `extension/` — Manifest V3 extension.
- `packaging/`, `tools/`, `.github/workflows/build.yml` — pinned binaries, models, installers.

## Developing

Requirements: Node 22, Python 3.13, ffmpeg, mpv, Xvfb for the Electron tests.

```
npm ci
pip install -r analyzer/requirements.txt
node tools/fetch-models.js            # ~1 GB, sha256-pinned
npm test                              # shared, desktop, player (needs mpv + ffmpeg)
npm run test:e2e                      # Electron end-to-end under xvfb
python -m unittest discover -s analyzer/tests
npm run test:extension                # plus `node extension/test/run.js` for the browser run
npm start                             # run the app (dev paths use system ffmpeg/mpv)
```

Building installers: see `packaging/README.md`. The whisper.cpp pins must be completed once on a
machine with GitHub access (`PIN_ON_FIRST_FETCH`), after which the workflow builds Windows x64
and macOS arm64/x64 artifacts with the first-launch text files next to them.

## Licences

The app's own licence is the owner's decision (none is set yet). Third-party components and
models are listed with their licences in `docs/LICENSES.md` and `packaging/BINARIES.md`; the
models are MIT and Apache-2.0 only.
