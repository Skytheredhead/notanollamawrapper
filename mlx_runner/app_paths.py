from __future__ import annotations

import os
import sys
from pathlib import Path

APP_SLUG = "naow"


def _root() -> Path:
    override = os.environ.get("NAOW_MLX_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return (Path.home() / "Library" / "Application Support" / APP_SLUG).resolve()
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata).expanduser() if appdata else (Path.home() / "AppData" / "Roaming")
        return (base / APP_SLUG).resolve()
    return (Path.home() / ".local" / "share" / APP_SLUG).resolve()


APP_SUPPORT_DIR = _root()
MODEL_DIR = APP_SUPPORT_DIR / "models"
RUNTIME_DIR = APP_SUPPORT_DIR / ".runtime" / "mlx"
LOG_DIR = APP_SUPPORT_DIR / "logs"


def ensure_dirs() -> None:
    for path in (APP_SUPPORT_DIR, MODEL_DIR, RUNTIME_DIR, LOG_DIR):
        path.mkdir(parents=True, exist_ok=True)
