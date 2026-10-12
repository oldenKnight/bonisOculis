# Third-party executables shipped with bonis oculis

The app runs these programs as separate processes. They are not linked into bonis oculis. Each
one is downloaded by `tools/fetch-binaries.js` from the address below, checked against the
sha256 in `packaging/binaries.json`, and only the files listed here are taken out of the
archive. The installer copies them to `<resources>/bin/`, together with `binaries.lock.json`
(the sha256 of every file) and the licence texts in `bin/licenses/`.

Pinned on 2026-10-12. "Pin pending" means the file could not be fetched from the machine that
wrote this list (GitHub was unreachable there): the build refuses it in CI until a maintainer runs
`node tools/fetch-binaries.js --platform win32 --arch x64 --write-pins` and commits the result.

## Windows x64 (`bin/win32-x64/`)

| File(s) | Program | Exact upstream file | sha256 of the download | Licence |
|---|---|---|---|---|
| `mpv.exe`, `d3dcompiler_43.dll`, `mpv/fonts.conf` | mpv 0.41.0, shinchiro build (baseline x86-64) | [mpv-0.41.0-x86_64.7z](https://downloads.sourceforge.net/project/mpv-player-windows/release/mpv-0.41.0-x86_64.7z) (31,430,559 bytes; SourceForge md5 `4047e85b…` matched) | `ef86fde0959d789d77a3ad7c3c2dca51c6999695363f493a6154f2c518634c0f` | GPL-2.0-or-later, built with GPL libraries |
| `ffmpeg.exe`, `ffprobe.exe` | FFmpeg 9.0.2 "essentials", static, gyan.dev | [ffmpeg-9.0.2-essentials_build.zip](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip) (114,768,076 bytes; gyan.dev's `.sha256` matched) | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` | GPL-3.0-or-later (`--enable-gpl --enable-version3`) |
| `whisper-cli.exe` + `whisper.dll`, `ggml*.dll`, `SDL2.dll` | whisper.cpp v1.9.5 CPU build | [whisper-bin-x64.zip](https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.5/whisper-bin-x64.zip) | pin pending | MIT |

## macOS Apple Silicon (`bin/darwin-arm64/`)

| File(s) | Program | Exact upstream file | sha256 of the download | Licence |
|---|---|---|---|---|
| `mpv.app/` (whole bundle, 52 files) + `mpv` (two-line shell launcher written by fetch-binaries) | mpv 0.40.0, stolendata build, macOS 14+ | [mpv-arm64-0.40.0.tar.gz](https://laboratory.stolendata.net/~djinn/mpv_osx/mpv-arm64-0.40.0.tar.gz) (21,956,184 bytes; sha256 published on the download page matched) | `3170fb709defebaba33e9755297d70dc3562220541de54fc3d494a8309ef1260` | GPL-2.0-or-later; bundled dylibs under their own licences |
| `ffmpeg` | FFmpeg 9.0.2 static, Martin Riedl build server | [ffmpeg.zip](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip) (28,395,699 bytes; publisher `.sha256` matched) | `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924` | GPL-3.0-or-later |
| `ffprobe` | same build | [ffprobe.zip](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip) (28,317,701 bytes) | `fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6` | GPL-3.0-or-later |
| `whisper-cli` | whisper.cpp v1.9.5, built from source by the macOS CI job (static, Metal embedded) | `git clone --branch v1.9.5 https://github.com/ggml-org/whisper.cpp` | commit pin pending | MIT |

## macOS Intel (`bin/darwin-x64/`)

| File(s) | Program | Exact upstream file | sha256 of the download | Licence |
|---|---|---|---|---|
| `mpv.app/` + `mpv` launcher | mpv 0.39.0, stolendata build, macOS 11+ (the newest Intel build stolendata offers) | [mpv-0.39.0.tar.gz](https://laboratory.stolendata.net/~djinn/mpv_osx/mpv-0.39.0.tar.gz) (23,791,174 bytes; published sha256 matched) | `35ec81ad86a97b24956a8d0f4fa1ba2690b44ae7741c920e923620bcd7bd402a` | GPL-2.0-or-later; bundled dylibs under their own licences |
| `ffmpeg` | FFmpeg 9.0.2 static, Martin Riedl build server | [ffmpeg.zip](https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip) (33,816,391 bytes; publisher `.sha256` matched) | `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4` | GPL-3.0-or-later |
| `ffprobe` | same build | [ffprobe.zip](https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip) (33,719,233 bytes) | `2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd` | GPL-3.0-or-later |
| `whisper-cli` | whisper.cpp v1.9.5, built from source by the macOS CI job (static, CPU + Accelerate) | as above | commit pin pending | MIT |

## Licence texts shipped in `bin/licenses/` (all platforms)

| File | Source | sha256 |
|---|---|---|
| `GPL-3.0.txt` | FFmpeg n9.0.2 `COPYING.GPLv3` (identical to gyan.dev's `LICENSE`) | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| `GPL-2.0.txt` | mpv v0.41.0 `LICENSE.GPL` | `edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6` |
| `LGPL-2.1.txt` | FFmpeg n9.0.2 `COPYING.LGPLv2.1` | `246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30` |
| `mpv-Copyright.txt` | mpv v0.41.0 `Copyright` | `bfe9ee4cceabcb8ecbfadf208d04156f73d801e6a57369a5606bb8341e204a23` |
| `whisper.cpp-MIT.txt` | whisper.cpp v1.9.5 `LICENSE` | `94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d` |

(Fetched through cdn.jsdelivr.net, which mirrors the tagged upstream trees.)

## Source code (GPL written offer)

mpv and FFmpeg are distributed here in binary form under the GNU GPL. The corresponding source
code is available from the places below; on request, the bonis oculis maintainers will provide
the same source for at least three years after the release that shipped these binaries, at no
more than the cost of making the copy. (Offer wording for the owner to approve before the first
public release; ledger Q1 leaves licensing decisions to him.)

| Program | Source |
|---|---|
| FFmpeg 9.0.2 (all platforms) | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz (sha256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`); gyan.dev build commit https://github.com/FFmpeg/FFmpeg/commit/946fcce07b and configuration in the build's README.txt; macOS build scripts https://git.martin-riedl.de/ffmpeg/build-script |
| mpv 0.41.0 (Windows) | https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz; every bundled library and its version: https://github.com/shinchiro/mpv-winbuild-cmake |
| mpv 0.40.0 (macOS arm64) | https://github.com/mpv-player/mpv/archive/refs/tags/v0.40.0.tar.gz |
| mpv 0.39.0 (macOS x64) | https://github.com/mpv-player/mpv/archive/refs/tags/v0.39.0.tar.gz |
| whisper.cpp v1.9.5 (MIT, listed for completeness) | https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz |

`node tools/fetch-binaries.js --sources <dir>` downloads this list (with a `SHA256SUMS`) so the
maintainer can publish it next to each release. That is the safe way to meet GPLv2 §3 / GPLv3 §6
for a distribution that is not purely non-commercial.

**Open compliance item (maintainer).** The macOS mpv builds from stolendata bundle
Homebrew-built dylibs (45 of them: FFmpeg 6 libraries, libass, libplacebo, harfbuzz, openssl, ...). Their
exact sources are not published next to the build. Before a public release either (a) collect
the source tarballs of those library versions (`otool -L mpv.app/Contents/MacOS/lib/*.dylib`
lists them) and publish them with the release, or (b) build mpv for macOS from source in CI.
The Windows (shinchiro) and FFmpeg builds publish their recipes, listed above.

## Why these builds

- **mpv, Windows:** shinchiro's SourceForge builds are the ones mpv.io links to. The tagged
  `release/mpv-0.41.0-x86_64.7z` is used instead of a weekly git build so the pin stays
  meaningful, and the baseline `x86_64` flavour instead of `-v3` (AVX2) so pre-2013 Intel i5
  machines (brief 4.2) can play.
- **FFmpeg, Windows:** gyan.dev's versioned package URLs are permanent and come with a
  publisher sha256; its essentials build has runtime CPU detection. BtbN's FFmpeg-Builds (the
  other common choice) publish rolling `latest` files and prune dated builds, so a pin would
  break; it is the fallback if gyan.dev disappears.
- **FFmpeg, macOS:** evermeet.cx publishes Intel builds only (and its download host was
  unreachable from the pinning machine); Martin Riedl's build server offers the same release for
  both arm64 and x86_64 with publisher checksums, so both Macs run FFmpeg natively (no Rosetta).
- **mpv, macOS:** stolendata is the maintained self-contained `mpv.app` build with published
  sha256 sums (arm64 0.40.0 from May 2025; its newest Intel build is 0.39.0). jnozsc's
  mpv-nightly-build is nightly-only, so it cannot be pinned to a release. The arm64 build needs
  macOS 14 or later: on macOS 12-13 Apple Silicon the player would not start (see packaging/README.md).
- **whisper-cli:** the analyzer uses whisper.cpp in-process (pywhispercpp) and falls back to this
  executable only if the binding is missing. Windows takes the upstream release zip; macOS builds
  it from the tagged source in CI because upstream does not publish macOS binaries.
