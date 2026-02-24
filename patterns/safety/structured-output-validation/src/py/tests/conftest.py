"""
conftest.py — Add the parent package directory to sys.path so tests
can import modules directly without going through the 'py' package name
(which collides with pytest's internal 'py' dependency).
"""

import sys
from pathlib import Path

# Add src/py/ to the front of sys.path so _types, mock_provider, etc.
# are importable directly by module name.
_pkg_dir = str(Path(__file__).resolve().parent.parent)
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)
