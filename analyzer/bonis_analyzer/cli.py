"""Command line: scan | evaluate | probe | version.

stdout carries protocol JSON lines only (see protocol.py); logs go to
stderr; tracebacks never reach stdout. Exit codes: 0 ok, 2 bad input,
3 model missing, 4 interrupted (resumable), 5 internal.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional

from . import __version__, config
from .protocol import (EXIT_BAD_INPUT, EXIT_INTERNAL, EXIT_INTERRUPTED, EXIT_OK, AnalyzerError, BadInput,
                       Protocol)

log = logging.getLogger("bonis")


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise BadInput(message)


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(prog="bonis-analyzer", description="bonis oculis analyzer")
    sub = p.add_subparsers(dest="cmd", parser_class=_Parser)
    s = sub.add_parser("scan", help="scan a movie and write its skip file")
    s.add_argument("--input", required=True)
    s.add_argument("--work", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--lang", default=None, choices=["es-MX", "en-US"],
                   help="UI/lexicon language (default es-MX); also the speech language when given")
    s.add_argument("--levels", default=None, help="JSON object category -> off|light|moderate|strict")
    s.add_argument("--stages", default="subtitles,frames,audio,speech,captions")
    s.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    s.add_argument("--device", default="auto", choices=["auto", "cpu", "dml", "coreml", "cuda"])
    s.add_argument("--priority", default="low", choices=["low", "normal"])
    s.add_argument("--models", default=None, help="model directory (default: $BONIS_MODELS_DIR or bundled)")
    s.add_argument("--scores-from", dest="scores_from", default=None,
                   help="test hook: per-second signal scores (JSON) replace the models")
    s.add_argument("--restart", action="store_true", help="discard the checkpoint and start over")
    s.add_argument("--force-speech", dest="force_speech", action="store_true",
                   help="run speech-to-text even when subtitles were found")
    s.add_argument("--whisper-cli", dest="whisper_cli", default=None,
                   help="whisper.cpp command-line executable (fallback when the Python binding is missing)")
    s.add_argument("--caption-budget", dest="caption_budget", type=int, default=None,
                   help="max shots sent to the caption model (default %d; --thorough = %d)"
                        % (config.CAPTION_MAX_SHOTS, config.CAPTION_MAX_SHOTS_THOROUGH))
    s.add_argument("--thorough", action="store_true", help="caption up to %d shots" % config.CAPTION_MAX_SHOTS_THOROUGH)
    s.add_argument("--profile", action="store_true",
                   help='print a final {"t":"profile"} line: per-stage wall time and peak memory')
    e = sub.add_parser("evaluate", help="compare a predicted skip file with a hand-marked one")
    e.add_argument("--truth", required=True)
    e.add_argument("--pred", required=True)
    e.add_argument("--tolerance", type=float, default=3.0)
    e.add_argument("--out", default=None)
    pr = sub.add_parser("probe", help="describe a media file")
    pr.add_argument("--input", required=True)
    v = sub.add_parser("version", help="print versions")
    v.add_argument("--cpu-features", dest="cpu_features", action="store_true",
                   help="also report the CPU features the dialogue/speech engines need (AVX2 on x86)")
    return p


def _setup_io() -> None:
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    level = os.environ.get("BONIS_LOG", "INFO").upper()
    logging.basicConfig(stream=sys.stderr, level=getattr(logging, level, logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def cmd_scan(args: argparse.Namespace, proto: Protocol) -> int:
    from .scan import Scan, install_signal_handlers  # noqa: PLC0415

    install_signal_handlers()
    args.lang_explicit = args.lang is not None
    args.lang = args.lang or "es-MX"
    proto.isolate_stdout()  # native libraries (whisper.cpp, llama.cpp, ORT) must never write into the protocol
    scan = Scan(args, proto)
    out = scan.run()
    proto.done(out)
    if getattr(args, "profile", False):
        proto.emit(scan.profiler.report())
    return EXIT_OK


def cmd_evaluate(args: argparse.Namespace, proto: Protocol) -> int:
    from . import evaluate  # noqa: PLC0415

    for pth in (args.truth, args.pred):
        if not os.path.isfile(pth):
            raise BadInput("file not found: %s" % pth)
    try:
        _, md = evaluate.run(args.truth, args.pred, args.tolerance, args.out)
    except ValueError as e:
        raise BadInput(str(e)) from e
    sys.stdout.write(md + "\n")
    sys.stdout.flush()
    return EXIT_OK


def cmd_probe(args: argparse.Namespace, proto: Protocol) -> int:
    from . import fingerprint  # noqa: PLC0415
    from .pipeline import probe  # noqa: PLC0415

    m = probe.probe(args.input)
    m["keyframeInterval"] = probe.keyframe_interval(args.input)
    m["fingerprint"] = dict(fingerprint.fingerprint(args.input))
    proto.emit(dict({"t": "probe"}, **m))
    return EXIT_OK


def cmd_version(args: argparse.Namespace, proto: Protocol) -> int:
    info = {"t": "version", "analyzer": __version__, "python": sys.version.split()[0], "modelSet": config.MODEL_SET}
    try:
        import numpy  # noqa: PLC0415

        info["numpy"] = numpy.__version__
    except Exception:  # noqa: BLE001
        pass
    try:
        from .models import _ort  # noqa: PLC0415 - telemetry off before import

        onnxruntime = _ort()
        info["onnxruntime"] = onnxruntime.__version__
        info["ortTelemetry"] = "off (%s=%s)" % ("ORT_DISABLE_TELEMETRY", os.environ.get("ORT_DISABLE_TELEMETRY"))
        info["providers"] = onnxruntime.get_available_providers()
    except Exception:  # noqa: BLE001
        info["onnxruntime"] = None
    from . import cpu  # noqa: PLC0415

    if cpu.ggml_supported():
        try:
            import llama_cpp  # noqa: PLC0415

            info["llamaCpp"] = llama_cpp.__version__
        except Exception:  # noqa: BLE001
            info["llamaCpp"] = None
    else:
        info["llamaCpp"] = None  # not imported: its native code may need AVX2 (cpu.py)
    if getattr(args, "cpu_features", False):
        info["cpu"] = cpu.report()
    proto.emit(info)
    return EXIT_OK


def main(argv: Optional[List[str]] = None) -> int:
    _setup_io()
    from . import privacy  # noqa: PLC0415

    before = privacy.snapshot()
    try:
        return _main(argv)
    finally:
        privacy.sweep(before)


def _main(argv: Optional[List[str]] = None) -> int:
    proto = Protocol()
    try:
        args = build_parser().parse_args(argv)
        if not args.cmd:
            raise BadInput("missing command: scan | evaluate | probe | version")
        fn = {"scan": cmd_scan, "evaluate": cmd_evaluate, "probe": cmd_probe, "version": cmd_version}[args.cmd]
        return fn(args, proto)
    except AnalyzerError as e:
        log.error("%s", e)
        proto.error(e.code, str(e))
        return e.code
    except KeyboardInterrupt:
        proto.error(EXIT_INTERRUPTED, "scan interrupted; it will resume from the checkpoint")
        return EXIT_INTERRUPTED
    except SystemExit as e:  # argparse --help
        return int(e.code or 0) if isinstance(e.code, int) else EXIT_BAD_INPUT
    except Exception as e:  # noqa: BLE001
        log.exception("internal error")
        proto.error(EXIT_INTERNAL, "internal error: %s" % (str(e)[:300] or type(e).__name__))
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
