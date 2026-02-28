import sys
from pathlib import Path

# Add src/py/ to sys.path so modules are directly importable
_pkg_dir = str(Path(__file__).resolve().parent.parent)
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)
