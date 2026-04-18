#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Run naow's native local SearXNG sidecar.")
    parser.add_argument("--home", default=".naow/search")
    parser.add_argument("--settings", default=".naow/search/settings.yml")
    parser.add_argument("--port", default="8088")
    args = parser.parse_args()

    home = Path(args.home).resolve()
    source = home / "searxng-src"
    venv_python = home / "searxng-venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not venv_python.exists() or not (source / "searx" / "webapp.py").exists():
        setup = Path(__file__).with_name("setup_search.py")
        subprocess.run([sys.executable, str(setup), "--home", str(home), "--settings", args.settings], check=True)

    env = os.environ.copy()
    env.update({
        "SEARXNG_SETTINGS_PATH": str(Path(args.settings).resolve()),
        "SEARXNG_BIND_ADDRESS": "127.0.0.1",
        "SEARXNG_PORT": str(args.port),
        "SEARXNG_DEBUG": "0",
    })
    os.chdir(source)
    os.execve(str(venv_python), [str(venv_python), "searx/webapp.py"], env)


if __name__ == "__main__":
    main()
