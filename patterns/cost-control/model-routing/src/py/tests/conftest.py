"""
Test conftest — makes the parent package importable directly.

The src/py/ directory is named 'py' which conflicts with pytest's own 'py' package.
This conftest adds src/py/ to sys.path so tests can import modules directly.
"""

import sys
from pathlib import Path

_pkg_dir = str(Path(__file__).resolve().parent.parent)
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)
