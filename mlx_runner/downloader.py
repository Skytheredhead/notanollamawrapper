from __future__ import annotations

import os
import threading
import time
from typing import Any

import requests
from huggingface_hub import HfApi, hf_hub_url

from .app_paths import MODEL_DIR, ensure_dirs
from .model_registry import DEFAULT_MODEL, MODEL_SPECS, ModelSpec, model_payload, model_ready

_lock = threading.RLock()
_thread: threading.Thread | None = None
_state: dict[str, Any] = {
    "status": "idle",
    "pct": 0,
    "step": "",
    "currentModel": "",
    "downloadedBytes": 0,
    "totalBytes": 0,
    "downloadRateBytesPerSec": 0.0,
    "etaSeconds": None,
    "retryCount": 0,
    "error": "",
    "promptState": "pending",
    "updatedAt": time.time(),
}


def _set(**patch: Any) -> None:
    with _lock:
        patch["updatedAt"] = time.time()
        _state.update(patch)


def _files_for(spec: ModelSpec) -> list[dict[str, Any]]:
    api = HfApi(token=os.environ.get("HF_TOKEN") or None)
    info = api.model_info(spec.repo_id, files_metadata=True)
    files: list[dict[str, Any]] = []
    for sibling in info.siblings:
        filename = str(getattr(sibling, "rfilename", "") or "")
        if not filename or filename.endswith(".md"):
            continue
        size = getattr(sibling, "size", None)
        files.append({"filename": filename, "size": size if isinstance(size, int) else None})
    return files


def _safe_destination(spec: ModelSpec, filename: str):
    relative = os.path.normpath(filename)
    if relative.startswith("..") or os.path.isabs(relative):
        raise ValueError(f"Unsafe model filename: {filename}")
    return spec.path / relative


def _auth_headers() -> dict[str, str]:
    token = os.environ.get("HF_TOKEN")
    return {"Authorization": f"Bearer {token}"} if token else {}


def _existing_complete_bytes(spec: ModelSpec, files: list[dict[str, Any]]) -> int:
    total = 0
    for item in files:
        expected = item.get("size")
        destination = _safe_destination(spec, item["filename"])
        if destination.is_file() and isinstance(expected, int) and destination.stat().st_size == expected:
            total += expected
    return total


def _progress_patch(downloaded: int, total: int, started_at: float) -> dict[str, Any]:
    elapsed = max(1.0, time.time() - started_at)
    rate = downloaded / elapsed if downloaded else 0.0
    remaining = max(0, total - downloaded)
    pct = int(round((downloaded / total) * 100)) if total else 0
    return {
        "pct": max(1, min(99, pct)),
        "downloadedBytes": downloaded,
        "downloadRateBytesPerSec": rate,
        "etaSeconds": int(round(remaining / max(rate, 1))) if remaining and rate else None,
    }


def _download_file(
    spec: ModelSpec,
    item: dict[str, Any],
    *,
    completed_before_file: int,
    total_bytes: int,
    started_at: float,
) -> int:
    filename = item["filename"]
    expected_size = item.get("size")
    destination = _safe_destination(spec, filename)
    if destination.is_file() and isinstance(expected_size, int) and destination.stat().st_size == expected_size:
        return 0

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(f"{destination.name}.part")
    resume_size = partial.stat().st_size if partial.exists() and isinstance(expected_size, int) else 0
    if isinstance(expected_size, int) and resume_size == expected_size:
        partial.replace(destination)
        return expected_size
    if isinstance(expected_size, int) and resume_size > expected_size:
        partial.unlink()
        resume_size = 0

    headers = _auth_headers()
    if resume_size:
        headers["Range"] = f"bytes={resume_size}-"

    url = hf_hub_url(repo_id=spec.repo_id, filename=filename, repo_type="model")
    response = requests.get(url, headers=headers, stream=True, timeout=(10, 60))
    try:
        if resume_size and response.status_code != 206:
            resume_size = 0
            headers.pop("Range", None)
            response.close()
            response = requests.get(url, headers=headers, stream=True, timeout=(10, 60))
        response.raise_for_status()

        mode = "ab" if resume_size else "wb"
        file_bytes = resume_size
        last_update = 0.0
        with open(partial, mode) as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                handle.write(chunk)
                file_bytes += len(chunk)
                now = time.time()
                if now - last_update >= 0.25:
                    last_update = now
                    _set(**_progress_patch(completed_before_file + file_bytes, total_bytes, started_at))
    finally:
        response.close()

    if isinstance(expected_size, int) and file_bytes != expected_size:
        raise IOError(f"Downloaded {filename} size {file_bytes} did not match expected {expected_size}")
    partial.replace(destination)
    return file_bytes


def status() -> dict[str, Any]:
    models = [model_payload(spec) for spec in MODEL_SPECS.values()]
    missing = [model["key"] for model in models if not model["ready"]]
    with _lock:
        payload = dict(_state)
    prompt_state = "complete"
    if missing:
        prompt_state = "accepted" if payload.get("status") in {"downloading", "retrying"} else "pending"
    payload.update({
        "modelsDir": str(MODEL_DIR),
        "models": models,
        "missing": missing,
        "promptState": prompt_state,
    })
    return payload


def _download(spec: ModelSpec) -> None:
    ensure_dirs()
    if model_ready(spec):
        _set(status="done", pct=100, step="models ready", currentModel="", etaSeconds=0, error="", promptState="complete")
        return

    try:
        files = _files_for(spec)
        total_bytes = sum(item["size"] or 0 for item in files)
        started_at = time.time()
        downloaded = _existing_complete_bytes(spec, files)
        _set(
            status="downloading",
            pct=1,
            step="preparing download",
            currentModel=spec.label,
            downloadedBytes=downloaded,
            totalBytes=total_bytes,
            downloadRateBytesPerSec=0.0,
            etaSeconds=None,
            error="",
            promptState="accepted",
        )

        for index, item in enumerate(files, start=1):
            filename = item["filename"]
            _set(step=filename, currentModel=spec.label)
            downloaded += _download_file(
                spec,
                item,
                completed_before_file=downloaded,
                total_bytes=total_bytes,
                started_at=started_at,
            )
            if total_bytes:
                _set(**_progress_patch(downloaded, total_bytes, started_at))
            else:
                _set(pct=max(1, min(99, int(round(index / max(1, len(files)) * 100)))))

        _set(status="done", pct=100, step="models ready", currentModel="", etaSeconds=0, error="", promptState="complete")
    except Exception as exc:
        _set(status="error", step="download failed", currentModel="", etaSeconds=None, error=str(exc))


def start_download(model_key: str | None = None) -> dict[str, Any]:
    global _thread
    spec = MODEL_SPECS.get(model_key or DEFAULT_MODEL.key, DEFAULT_MODEL)
    with _lock:
        if _thread is not None and _thread.is_alive():
            return status()
        _set(status="downloading", pct=1, step="preparing download", currentModel=spec.label, error="")
        _thread = threading.Thread(target=_download, args=(spec,), daemon=True)
        _thread.start()
    return status()
