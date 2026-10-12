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
| Fonts (see docs/DESIGN.md) | UI | OFL | yes |

Total shipped models: see analyzer/models/manifest.json (`shippedMiB`). GPL compliance for mpv
and ffmpeg: the installer's About screen links to the exact build sources and the project
repository keeps a copy of each build's source tarball reference (tools/fetch-binaries.js).
