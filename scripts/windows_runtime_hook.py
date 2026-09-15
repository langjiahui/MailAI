"""Persist frozen Windows startup failures that a windowed executable would hide."""
from __future__ import annotations

import faulthandler
import os
import sys
import traceback
from pathlib import Path


def _open_diagnostic_stream():
    configured = os.environ.get("MAILAI_DIAGNOSTIC_LOG", "").strip()
    if configured:
        path = Path(configured)
    else:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home())
        path = base / "MailAI" / "logs" / "startup.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path, path.open("a", encoding="utf-8", buffering=1)


if sys.platform == "win32" and getattr(sys, "frozen", False):
    try:
        _diagnostic_path, _diagnostic_stream = _open_diagnostic_stream()
        if sys.stdout is None:
            sys.stdout = _diagnostic_stream
        if sys.stderr is None:
            sys.stderr = _diagnostic_stream
        try:
            faulthandler.enable(_diagnostic_stream)
            if os.environ.get("MAILAI_STARTUP_TRACE") == "1":
                faulthandler.dump_traceback_later(15, repeat=True, file=_diagnostic_stream)
        except (OSError, RuntimeError):
            pass

        def _report_unhandled(exc_type, exc_value, exc_traceback):
            print("\n=== MailAI unhandled startup exception ===", file=_diagnostic_stream)
            traceback.print_exception(
                exc_type, exc_value, exc_traceback, file=_diagnostic_stream
            )
            _diagnostic_stream.flush()

        sys.excepthook = _report_unhandled
        print(
            f"Starting MailAI frozen runtime: python={sys.version.split()[0]} "
            f"executable={sys.executable}",
            file=_diagnostic_stream,
        )
    except Exception:
        # Diagnostics must never prevent the application itself from starting.
        pass
