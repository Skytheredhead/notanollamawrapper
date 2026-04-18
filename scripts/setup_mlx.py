#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import shutil
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".naow" / "mlx-venv"
PYTHON = VENV / "bin" / "python"
PREFERRED_MINOR = (3, 11)


def run(command: list[str]) -> None:
    print("$", " ".join(command), flush=True)
    subprocess.run(command, check=True)


def find_python() -> str:
    for candidate in ("python3.11", "python3.12", "python3"):
        resolved = shutil.which(candidate)
        if not resolved:
            continue
        output = subprocess.check_output(
            [resolved, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            text=True,
        ).strip()
        if output == f"{PREFERRED_MINOR[0]}.{PREFERRED_MINOR[1]}":
            return resolved
    fallback = shutil.which("python3")
    if not fallback:
        raise RuntimeError("python3 is required")
    return fallback


def venv_matches() -> bool:
    if not PYTHON.exists():
        return False
    try:
        output = subprocess.check_output(
            [str(PYTHON), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            text=True,
        ).strip()
    except Exception:
        return False
    return output == f"{PREFERRED_MINOR[0]}.{PREFERRED_MINOR[1]}"


def main() -> int:
    if VENV.exists() and not venv_matches():
        print(f"Removing MLX venv with incompatible Python at {VENV}")
        shutil.rmtree(VENV)

    if not VENV.exists():
        VENV.parent.mkdir(parents=True, exist_ok=True)
        run([find_python(), "-m", "venv", str(VENV)])

    run([str(PYTHON), "-m", "pip", "install", "--upgrade", "pip"])
    run([
        str(PYTHON),
        "-m",
        "pip",
        "install",
        "--upgrade",
        "fastapi",
        "uvicorn[standard]",
        "huggingface_hub",
        "pillow",
        "torch",
        "torchvision",
        "mlx",
        "mlx-vlm",
    ])
    print(f"MLX sidecar ready at {PYTHON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
