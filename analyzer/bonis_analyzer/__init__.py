"""bonis oculis analyzer package (see docs/PLAN.md section 4).

The skip-file library (``skipfile``) and media fingerprint (``fingerprint``)
are standard-library-only ports of shared/skipfile.js and
shared/fingerprint.js and are tested against the same spec/fixtures.

Privacy (brief 4.7, review A1): ONNX Runtime 1.29+ on Linux/macOS carries
Microsoft's 1DS telemetry client. It uploads usage events to
mobile.events.data.microsoft.com and writes
~/.cache/Microsoft/DeveloperTools/.onnxruntime/ plus mat-debug-<pid>.log and
.ses in $TMPDIR. The pinned versions (requirements.txt) have no such client;
the variable below is the client's own off switch (read from the native
library, verified with strace: 0 connects, 0 files) and is set here,
unconditionally, before anything can import onnxruntime. Every entry point
(``python -m bonis_analyzer``, the PyInstaller entry, the tests) imports this
package first. See privacy.py for the post-run sweep.
"""

import os as _os

_os.environ["ORT_DISABLE_TELEMETRY"] = "1"

__version__ = "0.1.0"
