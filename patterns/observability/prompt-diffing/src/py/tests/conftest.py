"""conftest.py — ensures local `py/` package takes precedence over installed `py` lib."""
import sys
from pathlib import Path

# Add src/ (parent of py/) to front of sys.path.
# This makes `import py` resolve to src/py/ before site-packages/py.
_src = str(Path(__file__).parent.parent.parent)  # …/src/
if _src not in sys.path:
    sys.path.insert(0, _src)
