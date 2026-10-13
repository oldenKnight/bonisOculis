"""PyInstaller entry point of the bundled analyzer (packaging/analyzer.spec).

Same behaviour as ``python -m bonis_analyzer``, plus one thing only a packaged build needs: the
installed app keeps ffmpeg, ffprobe, whisper-cli and the models next to the analyzer, not
inside it (packaging/README.md, "Resource layout"):

    <resources>/analyzer/bonis-analyzer[.exe]     this program (onedir: _internal/ beside it)
    <resources>/bin/ffmpeg[.exe], ffprobe, whisper-cli
    <resources>/models/                           every shipped model + the committed small files

When those exist and the caller did not say otherwise, the matching BONIS_* variables are set
before the CLI starts, so the Electron app can spawn the analyzer with no extra arguments.
An explicit environment variable or --models argument always wins. Nothing here touches the
network; ORT_DISABLE_TELEMETRY=1 is always set (ONNX Runtime telemetry off, review A1).
"""

import os
import sys

# ONNX Runtime 1.29+ telemetry off switch, before anything imports onnxruntime (review A1; the
# package __init__ sets it too). Unconditional: the user's environment cannot turn it back on.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"


def _default_env(resources):
    exe = ".exe" if os.name == "nt" else ""
    found = {}
    bin_dir = os.path.join(resources, "bin")
    for var, name in (("BONIS_FFMPEG", "ffmpeg"), ("BONIS_FFPROBE", "ffprobe"),
                      ("BONIS_WHISPER_CLI", "whisper-cli")):
        p = os.path.join(bin_dir, name + exe)
        if os.path.isfile(p):
            found[var] = p
    models = os.path.join(resources, "models")
    if os.path.isdir(models):
        found["BONIS_MODELS_DIR"] = models
    for k, v in found.items():
        if not os.environ.get(k):
            os.environ[k] = v


def run():
    if getattr(sys, "frozen", False):
        # sys.executable = <resources>/analyzer/bonis-analyzer[.exe]
        _default_env(os.path.dirname(os.path.dirname(os.path.abspath(sys.executable))))
    from bonis_analyzer.cli import main  # noqa: PLC0415 - after the environment is set

    return main()


if __name__ == "__main__":
    sys.exit(run())
