"""
Test conftest — makes the parent package importable as 'token_budget_middleware'.

The src/py/ directory is named 'py' which conflicts with pytest's own 'py' package.
This conftest adds src/py/ to sys.path under an alias so tests can import directly.
"""

import importlib
import sys
from pathlib import Path

# Point sys.path at the parent (src/py/) so we can import modules directly
_pkg_dir = str(Path(__file__).resolve().parent.parent)
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)
