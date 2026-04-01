"""
pytest configuration for the embedding-refresh Python tests.

Adds the pattern root directory to sys.path so that
`from src.py import ...` resolves correctly regardless of
which directory pytest is invoked from.
"""

import sys
from pathlib import Path

# Pattern root: patterns/data-pipeline/embedding-refresh/
_PATTERN_ROOT = Path(__file__).parent.parent.parent.parent
if str(_PATTERN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PATTERN_ROOT))
