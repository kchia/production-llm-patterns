"""
Configure pytest to find the py package correctly.

The 'py' directory name conflicts with pytest's internal 'py' dependency.
This conftest ensures the parent directory (src/) is on sys.path so that
``import py`` resolves to our package when using --import-mode=importlib.
"""

import sys
from pathlib import Path

# Add src/ to sys.path so 'import py' finds this package
_src_dir = str(Path(__file__).resolve().parent.parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)
