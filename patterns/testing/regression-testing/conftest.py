"""Register src/py as the 'regression_testing' package for test discovery."""
import importlib.util
import sys
from pathlib import Path

pkg_dir = Path(__file__).resolve().parent / "src" / "py"

spec = importlib.util.spec_from_file_location(
    "regression_testing",
    pkg_dir / "__init__.py",
    submodule_search_locations=[str(pkg_dir)],
)
mod = importlib.util.module_from_spec(spec)
sys.modules["regression_testing"] = mod
spec.loader.exec_module(mod)

for sub in ("types", "mock_provider"):
    sub_spec = importlib.util.spec_from_file_location(
        f"regression_testing.{sub}",
        pkg_dir / f"{sub}.py",
    )
    sub_mod = importlib.util.module_from_spec(sub_spec)
    sys.modules[f"regression_testing.{sub}"] = sub_mod
    sub_spec.loader.exec_module(sub_mod)
