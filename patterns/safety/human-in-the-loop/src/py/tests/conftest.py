"""
Shared pytest fixtures for Human-in-the-Loop tests.

The ``py/`` package name collides with the ``py`` library that pytest
depends on. This conftest works around the collision by replacing
``sys.modules["py"]`` with our local package *after* pytest has
finished its own imports.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Save reference to the py *library* that pytest already loaded
_pytest_py = sys.modules.get("py")

# Add src/ to the path so our py package is discoverable
_src_dir = str(Path(__file__).resolve().parents[2])
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

# Force-reload py as our local package (overriding the library)
_local_py_path = Path(__file__).resolve().parents[1]
if _local_py_path.exists():
    to_remove = [k for k in sys.modules if k == "py" or k.startswith("py.")]
    for k in to_remove:
        del sys.modules[k]
    import py  # noqa: F811 — this now imports our local package
