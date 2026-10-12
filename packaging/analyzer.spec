# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the bonis oculis analyzer (onedir, no PyTorch, no tkinter).
#
#   pyinstaller packaging/analyzer.spec --noconfirm \
#       --distpath dist/analyzer/<platform>-<arch> --workpath build/pyinstaller/<platform>-<arch>
#
# Output: dist/analyzer/<platform>-<arch>/bonis-analyzer/{bonis-analyzer[.exe], _internal/}
# electron-builder copies that folder to <resources>/analyzer/ (electron-builder.yml).
#
# Bundled data (analyzer/README.md, "Models"):
#   _internal/lexicon/{en,es}.json            spec/lexicon
#   _internal/models/clip_prompts.npz, yamnet_class_map.csv, florence_prompts.json
# The downloaded models are NOT inside the analyzer: they ship once in <resources>/models/ and
# packaging/analyzer-entry.py points BONIS_MODELS_DIR there.
#
# Native libraries: onnxruntime (CPU / DirectML / CoreML provider libraries), llama_cpp/lib/*
# (llama.cpp + ggml), pywhispercpp's _pywhispercpp extension with libwhisper/ggml. The last two
# are optional at runtime (the scan warns and skips the stage); the build does not fail without
# them unless BONIS_REQUIRE_OPTIONAL=1 (CI sets it).

import os
import sys

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))  # noqa: F821 - SPECPATH is set by PyInstaller
ANALYZER = os.path.join(ROOT, 'analyzer')
sys.path.insert(0, ANALYZER)
REQUIRE_OPTIONAL = os.environ.get('BONIS_REQUIRE_OPTIONAL') == '1'

datas = []
for name in ('en.json', 'es.json'):
    datas.append((os.path.join(ROOT, 'spec', 'lexicon', name), 'lexicon'))
for name in ('clip_prompts.npz', 'yamnet_class_map.csv', 'florence_prompts.json'):
    datas.append((os.path.join(ANALYZER, 'models', name), 'models'))

binaries = []
hiddenimports = collect_submodules('bonis_analyzer')


def _optional(module, fn):
    try:
        __import__(module)
    except Exception as e:  # noqa: BLE001
        msg = 'optional module %s not installed (%s); its stage will be skipped at runtime' % (module, e)
        if REQUIRE_OPTIONAL:
            raise SystemExit('analyzer.spec: ' + msg)
        print('WARNING analyzer.spec: ' + msg)
        return
    fn()


# ONNX Runtime: the provider libraries (DirectML.dll, onnxruntime_providers_*.dll/.so/.dylib).
binaries += collect_dynamic_libs('onnxruntime')
hiddenimports += ['onnxruntime', 'onnxruntime.capi._pybind_state']


def _llama():
    # llama_cpp loads lib{llama,ggml*}.{so,dylib,dll} from <package>/lib at import time.
    binaries.extend(collect_dynamic_libs('llama_cpp'))
    datas.extend(collect_data_files('llama_cpp', includes=['lib/*.metal', 'lib/*.metallib']))
    hiddenimports.extend(['llama_cpp', 'llama_cpp.llama', 'llama_cpp.llama_cpp'])


def _whisper():
    # The wheel's extension module sits at the site-packages root and links libwhisper/ggml from
    # pywhispercpp.libs (auditwheel / delocate / delvewheel); PyInstaller's binary dependency
    # analysis follows those links, so only the modules are named here.
    hiddenimports.extend(['pywhispercpp', 'pywhispercpp.model', '_pywhispercpp'])
    binaries.extend(collect_dynamic_libs('pywhispercpp'))


_optional('llama_cpp', _llama)
_optional('_pywhispercpp', _whisper)

EXCLUDES = [
    # never used, large, or GUI
    'torch', 'torchvision', 'torchaudio', 'tensorflow', 'jax', 'transformers', 'tokenizers',
    'tkinter', '_tkinter', 'Tkinter', 'turtle', 'idlelib',
    'matplotlib', 'scipy', 'pandas', 'PIL', 'cv2', 'sympy', 'onnx',
    'IPython', 'jupyter', 'notebook', 'pytest', 'setuptools', 'pip', 'pydoc_data',
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'wx', 'gi',
    # onnxruntime tooling that the runtime never imports (pulls onnx / sympy / torch)
    'onnxruntime.transformers', 'onnxruntime.quantization', 'onnxruntime.tools',
    'onnxruntime.training', 'onnxruntime.datasets',
    # optional extras of llama_cpp (server, from_pretrained) and requests (pyOpenSSL); the
    # analyzer never downloads anything
    'huggingface_hub', 'hf_xet', 'cryptography', 'OpenSSL', 'pydantic', 'pydantic_core',
    'pydantic_settings', 'starlette', 'fastapi', 'uvicorn', 'sse_starlette', 'rpds',
    'jsonschema', 'referencing',
]

a = Analysis(  # noqa: F821
    [os.path.join(SPECPATH, 'analyzer-entry.py')],  # noqa: F821
    pathex=[ANALYZER],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='bonis-analyzer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,          # stripping breaks macOS signatures; sizes are dominated by ORT/numpy
    upx=False,            # UPX trips antivirus heuristics on Windows
    console=True,         # stdout is the JSON-lines protocol; Electron spawns it with windowsHide
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,     # the runner's native arch (macos-14 arm64, macos-13 x86_64)
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='bonis-analyzer',
)
