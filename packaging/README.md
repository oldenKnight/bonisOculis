# Packaging (M9a)

How the installers are built: Windows x64 (NSIS, offline) and macOS (one DMG for Apple Silicon,
one for Intel). Everything the app needs ships inside the installer; nothing is downloaded at
runtime and nothing auto-updates.

| File | Role |
|---|---|
| `electron-builder.yml` (repo root) | installer configuration, resource layout |
| `packaging/binaries.json` | pinned third-party executables (URL, sha256, members to extract) |
| `packaging/BINARIES.md` | the same as prose: versions, licences, GPL source list (shipped as `help/BINARIES.md`) |
| `packaging/analyzer.spec`, `packaging/analyzer-entry.py` | PyInstaller onedir build of the analyzer |
| `packaging/make-icons.js`, `packaging/icons/` | app icons rendered from `logo-mark.svg` (committed) |
| `packaging/lib/fetchlib.js` | download / sha256 / zip / tar / 7z helpers for the tools below (build time only) |
| `packaging/test/packaging.test.js` | icon containers, archive safety, table consistency |
| `tools/fetch-binaries.js` | mpv, ffmpeg, ffprobe, whisper-cli into `bin/<platform>-<arch>/` |
| `tools/fetch-models.js` | models from `analyzer/models/manifest.json` into `analyzer/models/` |
| `tools/verify-bundle.js` | checks a built app before it ships |
| `.github/workflows/build.yml` | CI: tests on Linux, installers on Windows / macOS arm64 / macOS x64 |

## Resource layout inside the installed app

`desktop/main/paths.js` (packaged mode) and `packaging/analyzer-entry.py` both read this layout.
Each installer is for one platform and one architecture, so there is no `<platform>-<arch>`
level inside it: electron-builder maps `bin/<platform>-<arch>/` and
`dist/analyzer/<platform>-<arch>/bonis-analyzer/` onto flat folders.

```
<resources>/                      process.resourcesPath
  app.asar                        package.json, desktop/** (no tests, no design preview), shared/*.js
  bin/
    mpv[.exe]                     Windows: mpv.exe + d3dcompiler_43.dll + mpv/fonts.conf
                                  macOS: a 2-line sh launcher for mpv.app/Contents/MacOS/mpv
    mpv.app/                      macOS only: the self-contained mpv bundle
    ffmpeg[.exe], ffprobe[.exe]   static builds
    whisper-cli[.exe]             Windows: + whisper.dll, ggml*.dll, SDL2.dll
    licenses/                     GPL-2.0, GPL-3.0, LGPL-2.1, mpv Copyright, whisper.cpp MIT
    binaries.lock.json            sha256 of every file above (from tools/fetch-binaries.js)
  analyzer/
    bonis-analyzer[.exe]          PyInstaller onedir executable
    _internal/                    Python, numpy, onnxruntime, llama.cpp, whisper.cpp, the
                                  bonis_analyzer package, lexicon/{en,es}.json,
                                  models/{clip_prompts.npz, yamnet_class_map.csv, florence_prompts.json}
  models/                         every shipped model (tools/fetch-models.js --print-shipped):
                                  nsfw-vit-int8.onnx + its config/preprocessor JSON, CLIP vision +
                                  preprocessor, YAMNet, whisper
                                  small q5_1, Qwen3-0.6B, Florence-2 (8 files), the three
                                  committed sidecars, manifest.json
  player/bonis.lua
  spec/lexicon/{en,es}.json
  help/en-US.md, es-MX.md         docs/HELP
  help/LICENSES.md, BINARIES.md   docs/LICENSES.md, packaging/BINARIES.md
```

The Electron app spawns `<resources>/analyzer/bonis-analyzer` with no extra arguments.
`analyzer-entry.py` then sets, only when they are not already set, `BONIS_FFMPEG`,
`BONIS_FFPROBE`, `BONIS_WHISPER_CLI` (from `<resources>/bin/`) and `BONIS_MODELS_DIR`
(`<resources>/models`). `--models` or an explicit variable still wins.

Reconciliation with the request that started M9a: it asked for `resources/bin/<platform>-<arch>/`
and `resources/analyzer/<platform>-<arch>/analyzer(.exe)`. `desktop/main/paths.js` already
existed and reads `resources/bin/<name>` and `resources/analyzer/bonis-analyzer(.exe)`, so the
installer follows paths.js; the per-arch folders exist only in the repository (`bin/`, `dist/`).

## Build steps

Common to every OS (Node 22, Python 3.11, git):

```
npm ci
node tools/fetch-models.js                    # ~1 GB once; --from DIR reuses a local copy
node tools/fetch-models.js --check
python -m pip install -r analyzer/requirements.txt pyinstaller==6.22.3
pyinstaller packaging/analyzer.spec --noconfirm \
    --distpath dist/analyzer/<platform>-<arch> --workpath build/pyinstaller/<platform>-<arch>
```

Use `CMAKE_ARGS="-DGGML_NATIVE=OFF"` when pip builds llama-cpp-python from source, or the LM
stage is compiled for the build machine's CPU and can crash elsewhere (macOS arm64:
`-DGGML_NATIVE=OFF -DGGML_METAL=ON`; macOS Intel: `-DGGML_METAL=OFF`). Set
`BONIS_REQUIRE_OPTIONAL=1` to make the spec fail when llama-cpp-python or pywhispercpp is missing
(CI does).

### Windows x64

```
node tools/fetch-binaries.js --platform win32 --arch x64     # needs 7-Zip on PATH for the mpv .7z
node tools/fetch-binaries.js --check --platform win32 --arch x64
npx electron-builder@26.15.3 --win --x64 --publish never
node tools/verify-bundle.js dist/electron/win-unpacked --run-analyzer
```

Output: `dist/electron/bonis-oculis-<version>-win-x64-setup.exe` (assisted NSIS installer: the
user picks "just me" or "all users" and the folder; desktop and Start-menu shortcuts).

### macOS (run once per architecture, on that architecture)

```
node tools/fetch-binaries.js --platform darwin --arch arm64          # or x64
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp build/whisper.cpp
cmake -S build/whisper.cpp -B build/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DWHISPER_SDL2=OFF -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0   # Intel: -DGGML_METAL=OFF
cmake --build build/whisper.cpp/build --config Release --target whisper-cli
node tools/fetch-binaries.js --platform darwin --arch arm64 \
  --add-built whisper-cli=build/whisper.cpp/build/bin/whisper-cli \
  --built-commit "$(git -C build/whisper.cpp rev-parse HEAD)"
node tools/fetch-binaries.js --check --platform darwin --arch arm64
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder@26.15.3 --mac --arm64 --publish never -c.mac.identity=-
node tools/verify-bundle.js dist/electron/mac-arm64 --run-analyzer      # Intel: dist/electron/mac
```

Output: `dist/electron/bonis-oculis-<version>-mac-arm64.dmg` (and `-mac-x64.dmg`).

### Linux (development only)

`electron-builder.yml` has a `linux: dir` target so the layout can be checked on a Linux box. It
reads `bin/linux-x64/` (not produced by fetch-binaries: put system `mpv`, `ffmpeg`, `ffprobe`
there with a hand-made `binaries.lock.json`) and is never shipped.

## Pins

`tools/fetch-binaries.js` refuses, when `CI=true`, any entry of `packaging/binaries.json` whose
sha256 is `PIN_ON_FIRST_FETCH`. Today that is the Windows whisper.cpp release zip and the
whisper.cpp commit for the macOS build (GitHub was unreachable when the table was written).
Once, on a machine with GitHub access:

```
node tools/fetch-binaries.js --platform win32 --arch x64 --write-pins
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp /tmp/w && git -C /tmp/w rev-parse HEAD
#   -> put that commit in builds."whisper.cpp".commit
```

Check the downloaded zip's member names match the `whisper-cli.exe` / DLL patterns in the table
(the extraction fails loudly if they do not). Every other binary was downloaded and hashed when
the table was written, and where the publisher offers a checksum it matched (BINARIES.md).

## CI (`.github/workflows/build.yml`)

- `test` (ubuntu-24.04): `npm run lint`, `xvfb-run -a npm test`, `node --test packaging/test/*.test.js`,
  `npm run test:extension`, the analyzer unit tests, the Electron e2e under xvfb, and
  `node tools/verify-bundle.js --repo-only`.
- `build` (after `test`): windows-latest x64, macos-14 arm64, macos-15-intel x64. Caches the
  binary archives (key: hash of binaries.json) and the models (key: hash of the manifest, shared
  across OSes). Uploads the installer, its SHA256SUMS and the binaries lock.
- No secret is needed. Signing / notarization steps run only when `MAC_CSC_LINK`,
  `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
  `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` exist. Unsigned macOS builds are ad-hoc signed so they
  run on Apple Silicon; Gatekeeper still asks on first launch (the help covers it).

## Decisions and their reasons

- **Two macOS DMGs, not one universal app.** The sidecars differ per architecture in content,
  not just in CPU slices: mpv.app arm64 is 0.40.0 and x64 is 0.39.0 with different dylib sets,
  and the PyInstaller trees differ file by file. `@electron/universal` merges two apps only when
  their non-Mach-O files are identical and every Mach-O exists in both, so it would fail; lipo-ing
  45 dylibs and a Python tree by hand is fragile. Two downloads, each about half the size of a
  universal one.
- **Flat `bin/` and `analyzer/`** in the installed app: one platform per installer, and
  `desktop/main/paths.js` already reads that layout.
- **Models next to the analyzer, not inside it.** `<resources>/models` is the one copy;
  `analyzer-entry.py` points the analyzer at it. Only the three small committed sidecars are
  also inside `_internal/models` so the bare analyzer can run `--scores-from` tests.
- **No model archives.** Every model is a plain file from the manifest. NudeNet (previously
  extracted from its sdist) was dropped for licence ambiguity (ledger D22); the nudity classifier
  is `nsfw-vit-int8.onnx` (Apache-2.0).
- **Hardened runtime off** until a Developer ID exists (it requires a real signature).
- **asar on, nothing unpacked**: every executable lives in `resources/`, outside the archive.

## Measured on the Linux dev container (2026-10-12)

- `pyinstaller packaging/analyzer.spec`: 29 s; `dist/.../bonis-analyzer` = 115 MiB on Linux x64
  (onnxruntime 29 MiB, numpy + its OpenBLAS 41 MiB, llama.cpp 14 MiB, whisper.cpp 3 MiB,
  libpython 7 MiB). Before trimming optional extras of llama-cpp-python (huggingface_hub, hf_xet,
  pydantic, cryptography) it was 159 MiB.
- Start-up: `bonis-analyzer version` (imports onnxruntime and llama.cpp) 0.29-0.34 s wall;
  `--help` 0.15 s. Same command through `python -c`: 0.23 s.
- Full scan of a 30 s testsrc2 + sine clip through the bundled binary with `--scores-from`
  (all seven stages): 1.8 s, exit 0, two ranges written, thumbnails written.
- Real models, `--stages subtitles,frames`, models found through the entry's
  `BONIS_MODELS_DIR` default in a simulated `<resources>` tree: 2.8 s wall, frames stage 2.1 s for
  30 frames, peak RSS 290 MB. Same with `BONIS_MODELS_DIR` pointing at the raw download folder
  (NudeNet, since dropped, read from the tarball): exit 0.
- Real models, `--stages subtitles,speech,frames,audio`: whisper.cpp (pywhispercpp), YAMNet and
  the Qwen3 LM all ran inside the bundle; 21.6 s wall, peak RSS 999 MB (LM stage).
- electron-builder 26.15.3 `--linux dir` with the real models and analyzer: layout as above,
  `tools/verify-bundle.js` passes. Resource sizes: models 970 MiB, analyzer 115 MiB.
- Third-party binaries per target (uncompressed): win32-x64 316 MiB (ffmpeg.exe and ffprobe.exe
  are 105 MiB each, static; mpv.exe 116 MiB), darwin-arm64 174 MiB, darwin-x64 234 MiB. A shared
  FFmpeg build would save about 100 MiB on Windows; the installers are LZMA/zlib compressed.

## Known limits

- **mpv on Apple Silicon needs macOS 14+** (stolendata's arm64 build). Electron 38 runs on
  macOS 12+, so an M1 on macOS 12-13 installs the app but the player will not start. Options:
  ship the Intel mpv there under Rosetta, or build mpv for arm64 with a lower deployment target.
- **CPU baseline of the LM and whisper-cli builds.** With `GGML_NATIVE=OFF`, llama.cpp and
  whisper.cpp still assume AVX2/FMA/F16C on x86 by default (Haswell, 2013+). Pre-Haswell i5s
  would crash in the LM stage; ONNX Runtime, numpy and FFmpeg detect the CPU at runtime. Not
  tested here (no such machine).
- **GitHub was unreachable** from the machine that wrote this, so the Windows whisper-cli zip and
  the macOS whisper.cpp commit are not pinned, nothing was built on Windows or macOS, and the
  workflow has not run yet. The Linux run above is the evidence that the spec, entry point,
  extraResources mapping and verify-bundle work.

## First-launch text files (from the desktop agent)

The unsigned-build steps (macOS 15+ Privacy & Security › Open Anyway, macOS 14 and earlier
Control-click › Open, Windows SmartScreen More info › Run anyway) must be readable before the app
opens. They live in `docs/INSTALL/en-US.md` and `docs/INSTALL/es-MX.md` (the same text as the
in-app Help section "Before you install"). The packaging owner should ship them next to the
installer as plain text files: `FIRST-LAUNCH.txt` (en-US) and `PRIMER-INICIO.txt` (es-MX), inside
the DMG window and beside the NSIS installer on the download page. Not wired into
electron-builder.yml by this note.
