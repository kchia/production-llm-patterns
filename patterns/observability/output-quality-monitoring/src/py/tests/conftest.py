"""Add src/py to sys.path so 'quality_monitoring' package is importable."""

import sys
from pathlib import Path

_src_py = str(Path(__file__).resolve().parent.parent)
if _src_py not in sys.path:
    sys.path.insert(0, _src_py)
