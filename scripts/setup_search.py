#!/usr/bin/env python3
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_URL = "https://github.com/searxng/searxng.git"


def run(args, cwd=None):
    print("+", " ".join(str(arg) for arg in args), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def copy_settings(settings: Path, template: Path):
    settings.parent.mkdir(parents=True, exist_ok=True)
    if settings.exists():
        return
    if template.exists():
        shutil.copyfile(template, settings)
    else:
        settings.write_text(
            """use_default_settings: true

server:
  secret_key: "naow-local-search-change-me"
  bind_address: "127.0.0.1"
  port: 8088
  limiter: false
  image_proxy: false

search:
  safe_search: 0
  formats:
    - html
    - json

outgoing:
  request_timeout: 2.0
""",
            encoding="utf-8",
        )


def main():
    parser = argparse.ArgumentParser(description="Install naow's native local SearXNG sidecar.")
    parser.add_argument("--home", default=".naow/search")
    parser.add_argument("--settings", default=".naow/search/settings.yml")
    parser.add_argument("--settings-template", default="search/searxng/settings.yml")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()

    home = Path(args.home).resolve()
    source = home / "searxng-src"
    venv = home / "searxng-venv"
    settings = Path(args.settings).resolve()
    template = Path(args.settings_template).resolve()
    venv_python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    home.mkdir(parents=True, exist_ok=True)
    copy_settings(settings, template)

    if not source.exists():
        run(["git", "clone", "--depth", "1", REPO_URL, str(source)])
    else:
        run(["git", "fetch", "--depth", "1", "origin"], cwd=source)
        run(["git", "reset", "--hard", "origin/master"], cwd=source)

    if not venv_python.exists():
        run([args.python, "-m", "venv", str(venv)])

    run([str(venv_python), "-m", "pip", "install", "-U", "pip", "setuptools", "wheel"])
    run([str(venv_python), "-m", "pip", "install", "-U", "pyyaml", "msgspec", "typing-extensions", "pybind11"])
    run([str(venv_python), "-m", "pip", "install", "--use-pep517", "--no-build-isolation", "-e", "."], cwd=source)
    print(f"Local search installed at {home}")


if __name__ == "__main__":
    main()
