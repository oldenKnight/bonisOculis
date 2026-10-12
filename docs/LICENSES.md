# Third-party components and licences (inventory)

Verified 2026-10-12. Binaries and models are separate files; the app launches mpv, ffmpeg and
whisper-cli as separate processes and loads models as data.

| Component | Use | Licence | Shipped |
|---|---|---|---|
| Electron | app shell | MIT | yes |
| mpv | playback engine (separate process) | GPL-2.0+ (binary builds) | yes, with source offer |
| ffmpeg | decode/sampling, clean copy | GPL (static builds) | yes, with source offer |
| whisper.cpp (whisper-cli) | speech-to-text sidecar | MIT | yes |
| llama.cpp (via llama-cpp-python) | dialogue LM | MIT | yes |
| ONNX Runtime (+DirectML on Windows, CoreML on macOS) | model inference | MIT | yes |
| Python 3.11 (python-build-standalone) | analyzer runtime | PSF | yes |
| NudeNet 3.4.2 model 320n | nudity detector | MIT | yes (10 MB) |
| CLIP ViT-B/32 (OpenAI weights, Xenova ONNX int8) | zero-shot scene scores | MIT | vision only (85 MB) |
| YAMNet ONNX (andrelgomes) | audio events | Apache-2.0 | yes (16 MB) |
| whisper small q5_1 | STT model | MIT | yes (182 MB) |
| Qwen3-0.6B Q4_K_M | dialogue/caption scoring | Apache-2.0 | yes (462 MB) |
| Florence-2 base-ft q4f16 (onnx-community) | keyframe captions | MIT | yes (~215 MB) |
| Atkinson Hyperlegible Next (variable, latin) | UI body font | SIL OFL 1.1 | yes (34 KB) |
| Fraunces (variable, latin) | UI titles | SIL OFL 1.1 | yes (37 KB) |

Total shipped models: see analyzer/models/manifest.json (`shippedMiB`). GPL compliance for mpv
and ffmpeg: the installer's About screen links to the exact build sources and the project
repository keeps a copy of each build's source tarball reference (tools/fetch-binaries.js).

## Shipped third-party executables (M9a, pinned 2026-10-12)

Exact files, fetched and sha256-checked by `tools/fetch-binaries.js` from `packaging/binaries.json`;
the installer carries them in `<resources>/bin/` with `binaries.lock.json` and the licence texts in
`bin/licenses/`. Details, reasons and the GPL source list: `packaging/BINARIES.md` (also shipped as
`help/BINARIES.md`).

| Target | Program | Version / build | Upstream file | sha256 | Licence |
|---|---|---|---|---|---|
| Windows x64 | mpv (`mpv.exe`, `d3dcompiler_43.dll`, `mpv/fonts.conf`) | 0.41.0, shinchiro, baseline x86-64 | sourceforge.net/projects/mpv-player-windows/files/release/mpv-0.41.0-x86_64.7z | `ef86fde0959d789d77a3ad7c3c2dca51c6999695363f493a6154f2c518634c0f` | GPL-2.0-or-later (GPL libraries linked in) |
| Windows x64 | ffmpeg.exe, ffprobe.exe | 9.0.2 essentials, gyan.dev, static | gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` | GPL-3.0-or-later |
| Windows x64 | whisper-cli.exe + whisper/ggml/SDL2 DLLs | whisper.cpp v1.9.5 | github.com/ggml-org/whisper.cpp/releases/download/v1.9.5/whisper-bin-x64.zip | PIN_ON_FIRST_FETCH | MIT |
| macOS arm64 | mpv.app (+ `mpv` launcher script) | 0.40.0, stolendata, macOS 14+ | laboratory.stolendata.net/~djinn/mpv_osx/mpv-arm64-0.40.0.tar.gz | `3170fb709defebaba33e9755297d70dc3562220541de54fc3d494a8309ef1260` | GPL-2.0-or-later; 45 bundled dylibs under their own licences |
| macOS arm64 | ffmpeg | 9.0.2, Martin Riedl build server, static | ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip | `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924` | GPL-3.0-or-later |
| macOS arm64 | ffprobe | same | .../1789931890_9.0.2/ffprobe.zip | `fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6` | GPL-3.0-or-later |
| macOS x64 | mpv.app (+ launcher) | 0.39.0, stolendata, macOS 11+ | laboratory.stolendata.net/~djinn/mpv_osx/mpv-0.39.0.tar.gz | `35ec81ad86a97b24956a8d0f4fa1ba2690b44ae7741c920e923620bcd7bd402a` | GPL-2.0-or-later; bundled dylibs under their own licences |
| macOS x64 | ffmpeg | 9.0.2, Martin Riedl build server, static | ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip | `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4` | GPL-3.0-or-later |
| macOS x64 | ffprobe | same | .../1789931006_9.0.2/ffprobe.zip | `2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd` | GPL-3.0-or-later |
| macOS both | whisper-cli | whisper.cpp v1.9.5, built from the tag in CI (static) | github.com/ggml-org/whisper.cpp (tag v1.9.5; commit pin pending) | lock records the built file | MIT |
| all | licence texts | GPL-2.0, GPL-3.0, LGPL-2.1, mpv Copyright, whisper.cpp MIT | cdn.jsdelivr.net mirrors of the tagged FFmpeg / mpv / whisper.cpp trees | pinned in binaries.json | — |
| all | Python runtime + numpy, onnxruntime, llama-cpp-python, pywhispercpp (inside `analyzer/_internal`) | as resolved by `pip install -r analyzer/requirements.txt` at build time | PyPI | not pinned by hash (see below) | PSF, BSD-3-Clause (numpy; OpenBLAS BSD-3-Clause), MIT (onnxruntime, llama.cpp, whisper.cpp, pywhispercpp) |

The analyzer's Python packages are installed from PyPI at build time by version range, not by
hash; a `requirements.lock` with `--require-hashes` is the next step if reproducible analyzer
builds are wanted.

### Licence findings from M9a (need a decision; not changed here)

- **NudeNet 3.4.2.** The sdist's PKG-INFO says `License: MIT`, but the `LICENSE` and
  `LICENSE.md` files inside the same tarball are the **GNU Affero GPL v3** text (checked
  2026-10-12). The table above and decision D14 list the 320n model as MIT. Until the owner or
  planner settles which applies to the 320n weights we ship, treat it as possibly AGPL-3.0:
  distributing it inside the installer would then require offering the corresponding source
  (and AGPL terms for any network use, which bonis oculis does not have). A model with an
  unambiguous permissive licence would remove the question.
- **mpv for macOS (stolendata).** The bundle carries 45 Homebrew-built dylibs whose exact sources
  are not published with the build. Full GPL compliance needs those sources collected and
  published with each release, or mpv built from source in CI (packaging/BINARIES.md).
- **Written offer.** `packaging/BINARIES.md` contains a three-year written-offer paragraph for
  the GPL binaries; it commits the maintainers and needs the owner's approval (ledger Q1).
