from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from .app_paths import MODEL_DIR, ensure_dirs
from .downloader import start_download, status as download_status
from .model_registry import DEFAULT_MODEL, MODEL_SPECS, ModelSpec, model_payload, model_ready, spec_for_name

app = FastAPI()
_runtime_lock = threading.RLock()
_runtime: dict[str, Any] = {
    "loaded": {},
    "residency": "always_hot",
    "activeStreams": 0,
    "lastActiveAt": time.monotonic(),
    "idleUnloadSeconds": float(os.environ.get("NAOW_MLX_IDLE_UNLOAD_SECONDS", "120")),
    "idleCheckSeconds": float(os.environ.get("NAOW_MLX_IDLE_CHECK_SECONDS", "30")),
}
_preflight_lock = threading.RLock()
_preflight_result: dict[str, Any] | None = None


def _clear_mlx_cache() -> None:
    try:
        import mlx.core as mx
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
    except Exception:
        pass
    gc.collect()


def _touch_runtime() -> None:
    with _runtime_lock:
        _runtime["lastActiveAt"] = time.monotonic()


def _stream_started() -> None:
    with _runtime_lock:
        _runtime["activeStreams"] = int(_runtime.get("activeStreams") or 0) + 1
        _runtime["lastActiveAt"] = time.monotonic()


def _stream_finished() -> None:
    with _runtime_lock:
        _runtime["activeStreams"] = max(0, int(_runtime.get("activeStreams") or 0) - 1)
        _runtime["lastActiveAt"] = time.monotonic()


def _summarize_preflight(stderr: str, stdout: str, returncode: int) -> str:
    combined = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part)
    for line in combined.splitlines():
        if "NSRangeException" in line or "libmlx" in line or "Metal" in line:
            return f"MLX native preflight failed with exit code {returncode}: {line.strip()}"
    if combined:
        tail = combined.splitlines()[-1].strip()
        return f"MLX native preflight failed with exit code {returncode}: {tail}"
    return f"MLX native preflight failed with exit code {returncode}."


def _run_mlx_preflight() -> dict[str, Any]:
    global _preflight_result
    with _preflight_lock:
        if _preflight_result is not None:
            return _preflight_result

        try:
            completed = subprocess.run(
                [sys.executable, "-c", "import mlx.core as mx; print('mlx ok')"],
                cwd=os.getcwd(),
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            if completed.returncode == 0:
                _preflight_result = {
                    "ok": True,
                    "message": "MLX native runtime imported successfully.",
                }
            else:
                _preflight_result = {
                    "ok": False,
                    "code": "mlx_preflight_failed",
                    "message": _summarize_preflight(completed.stderr, completed.stdout, completed.returncode),
                }
        except subprocess.TimeoutExpired:
            _preflight_result = {
                "ok": False,
                "code": "mlx_preflight_timeout",
                "message": "MLX native preflight timed out while importing mlx.core.",
            }

        return _preflight_result


def _ensure_mlx_preflight() -> None:
    result = _run_mlx_preflight()
    if not result.get("ok"):
        raise HTTPException(status_code=503, detail=result)


def _load_model_objects(spec: ModelSpec) -> dict[str, Any]:
    if spec.backend == "vlm":
        from mlx_vlm import VisionFeatureCache, load

        model, processor = load(str(spec.path))
        return {
            "modelName": spec.name,
            "backend": spec.backend,
            "pinned": spec.pinned,
            "model": model,
            "processor": processor,
            "visionCache": VisionFeatureCache(),
            "promptCaches": {},
            "generationLock": threading.RLock(),
        }

    from mlx_lm import load

    model, tokenizer = load(str(spec.path))
    return {
        "modelName": spec.name,
        "backend": spec.backend,
        "pinned": spec.pinned,
        "model": model,
        "tokenizer": tokenizer,
        "promptCaches": {},
        "generationLock": threading.RLock(),
    }


def _load_runtime(model_name: str | None = None) -> dict[str, Any]:
    spec = spec_for_name(model_name)
    if not model_ready(spec):
        raise HTTPException(status_code=409, detail={"code": "model_missing", "message": f"Download {spec.label} first."})
    _ensure_mlx_preflight()

    with _runtime_lock:
        loaded = _runtime["loaded"]
        if spec.name not in loaded:
            loaded[spec.name] = _load_model_objects(spec)
        _runtime["lastActiveAt"] = time.monotonic()
        return loaded[spec.name]


def _unload_runtime(model_name: str | None = None, *, include_pinned: bool = False) -> list[str]:
    unloaded: list[str] = []
    with _runtime_lock:
        loaded = _runtime["loaded"]
        names = [model_name] if model_name else list(loaded.keys())
        for name in names:
            runtime = loaded.get(name)
            if not runtime:
                continue
            if runtime.get("pinned") and not include_pinned:
                continue
            unloaded.append(name)
            del loaded[name]
    if unloaded:
        _clear_mlx_cache()
    return unloaded


def _stable_json(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except TypeError:
        return str(value)


def _cache_digest(parts: list[Any]) -> str:
    return hashlib.sha256("\n".join(str(part) for part in parts).encode("utf-8")).hexdigest()[:32]


def _prompt_cache_request(payload: dict[str, Any], runtime: dict[str, Any], images: list[str]) -> dict[str, Any]:
    raw = payload.get("cache") if isinstance(payload.get("cache"), dict) else {}
    enabled = raw.get("usePromptCache", raw.get("enabled", False)) is not False
    chat_id = str(raw.get("chatId") or "").strip()
    if not enabled:
        return {"enabled": False, "disabledReason": "disabled"}
    if runtime.get("backend") != "vlm":
        return {"enabled": False, "disabledReason": "backend_unsupported"}
    if not chat_id:
        return {"enabled": False, "disabledReason": "missing_chat_id"}

    attachment_signature = str(raw.get("attachmentSignature") or "|".join(images) or "none")
    key = _cache_digest([
        runtime.get("modelName") or "",
        chat_id,
        raw.get("cacheBranchId") or "main",
        raw.get("systemPromptHash") or "",
        attachment_signature,
    ])
    return {
        "enabled": True,
        "key": key,
        "chatId": chat_id,
        "branchId": str(raw.get("cacheBranchId") or "main"),
        "attachmentSignature": attachment_signature,
    }


def _token_ids_for_prompt(processor: Any, prompt: str) -> list[int]:
    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        tokenizer = processor
    if hasattr(tokenizer, "encode"):
        encoded = tokenizer.encode(prompt)
    else:
        encoded = tokenizer(prompt)
    if isinstance(encoded, dict):
        encoded = encoded.get("input_ids") or []
    if hasattr(encoded, "tolist"):
        encoded = encoded.tolist()
    if encoded and isinstance(encoded[0], list):
        encoded = encoded[0]
    return [int(item) for item in encoded]


def _prompt_cache_state(runtime: dict[str, Any], request: dict[str, Any]) -> tuple[Any | None, dict[str, Any]]:
    if not request.get("enabled"):
        return None, {
            "enabled": False,
            "hit": False,
            "disabledReason": request.get("disabledReason") or "disabled",
        }
    try:
        from mlx_vlm.generate import PromptCacheState
    except Exception as exc:
        return None, {
            "enabled": False,
            "hit": False,
            "disabledReason": f"unavailable:{exc}",
        }

    caches = runtime.setdefault("promptCaches", {})
    key = request["key"]
    state = caches.get(key)
    created = False
    if state is None:
        state = PromptCacheState()
        caches[key] = state
        created = True
    return state, {
        "enabled": True,
        "hit": not created,
        "key": key,
        "chatId": request.get("chatId"),
        "branchId": request.get("branchId"),
        "priorTokens": len(getattr(state, "token_ids", []) or []),
    }


def _trim_vlm_cache_to_prefix(kv_cache: list[Any], prefix_len: int) -> None:
    for cache_item in kv_cache:
        if hasattr(cache_item, "keys") and cache_item.keys is not None:
            cached_len = cache_item.keys.shape[2]
            if cached_len > prefix_len:
                cache_item.keys = cache_item.keys[:, :, :prefix_len, :]
                cache_item.values = cache_item.values[:, :, :prefix_len, :]
                if hasattr(cache_item, "offset"):
                    cache_item.offset = prefix_len


def _warm_vlm_prompt_cache(
    runtime: dict[str, Any],
    prompt: Any,
    images: list[str],
    options: dict[str, Any],
    cache_request: dict[str, Any],
) -> dict[str, Any]:
    started_at = time.monotonic()
    if images:
        return {
            "warmed": False,
            "enabled": False,
            "disabledReason": "images_not_supported_for_warm",
        }

    prompt_cache_state, cache_metrics = _prompt_cache_state(runtime, cache_request)
    if prompt_cache_state is None:
        return {
            "warmed": False,
            **cache_metrics,
            "elapsedMs": round((time.monotonic() - started_at) * 1000, 3),
        }

    try:
        import mlx.core as mx
        from mlx_vlm.generate import generate_step
        from mlx_vlm.models import cache
        from mlx_vlm.utils import prepare_inputs

        model = runtime["model"]
        processor = runtime["processor"]
        tokenizer = processor.tokenizer if hasattr(processor, "tokenizer") else processor
        add_special_tokens = (
            getattr(processor, "chat_template", None) is None
            if model.config.model_type in ["gemma3", "gemma3n", "gemma4"]
            else True
        )
        image_token_index = getattr(model.config, "image_token_index", None)
        inputs = prepare_inputs(
            processor,
            images=None,
            audio=None,
            prompts=prompt,
            image_token_index=image_token_index,
            add_special_tokens=add_special_tokens,
            **options,
        )
        input_ids = inputs.get("input_ids", None)
        pixel_values = inputs.get("pixel_values", None)
        mask = inputs.get("attention_mask", None)
        data_kwargs = {
            key: value
            for key, value in inputs.items()
            if key not in ["input_ids", "pixel_values", "attention_mask"]
        }

        full_token_ids = input_ids.flatten().tolist()
        full_token_ids = [int(item) for item in full_token_ids]
        prefix_len = 0
        warm_kwargs = _generation_kwargs(options)
        warm_kwargs.pop("enable_thinking", None)
        warm_kwargs.pop("thinking_budget", None)
        warm_kwargs["max_tokens"] = 0
        warm_kwargs.update(data_kwargs)
        with runtime.setdefault("generationLock", threading.RLock()):
            tracked_cache = prompt_cache_state.cache
            if tracked_cache is not None:
                prefix_len = prompt_cache_state.find_prefix_length(full_token_ids)
                if prefix_len >= len(full_token_ids):
                    cache_metrics.update({
                        "hit": True,
                        "reusedTokens": prefix_len,
                        "newTokens": 0,
                        "promptTokens": len(full_token_ids),
                        "elapsedMs": round((time.monotonic() - started_at) * 1000, 3),
                        "warmed": True,
                    })
                    return cache_metrics
                if prefix_len > 0:
                    input_ids = input_ids[:, prefix_len:]
                    _trim_vlm_cache_to_prefix(tracked_cache, prefix_len)

            if tracked_cache is None:
                tracked_cache = cache.make_prompt_cache(
                    model.language_model,
                    max_kv_size=options.get("max_kv_size", None),
                )

            for _token, _logprobs in generate_step(
                input_ids,
                model,
                pixel_values,
                mask,
                prompt_cache=tracked_cache,
                **warm_kwargs,
            ):
                pass
            mx.eval([item.state for item in tracked_cache])
            prompt_cache_state.update(full_token_ids, tracked_cache)
        cache_metrics.update({
            "hit": prefix_len > 0,
            "reusedTokens": prefix_len,
            "newTokens": max(0, len(full_token_ids) - prefix_len),
            "promptTokens": len(full_token_ids),
            "elapsedMs": round((time.monotonic() - started_at) * 1000, 3),
            "warmed": True,
            "tokenizer": getattr(tokenizer, "name_or_path", None),
        })
        return cache_metrics
    except Exception as exc:
        return {
            "warmed": False,
            "enabled": False,
            "hit": False,
            "disabledReason": f"warm_failed:{exc}",
            "elapsedMs": round((time.monotonic() - started_at) * 1000, 3),
            "key": cache_metrics.get("key"),
        }


def _idle_cleanup(*, min_idle_seconds: float = 0, include_pinned: bool = False) -> dict[str, Any]:
    with _runtime_lock:
        active_streams = int(_runtime.get("activeStreams") or 0)
        idle_for = max(0.0, time.monotonic() - float(_runtime.get("lastActiveAt") or time.monotonic()))
        if active_streams:
            return {"cleaned": False, "reason": "active_streams", "activeStreams": active_streams, "idleForSeconds": idle_for}
        if idle_for < min_idle_seconds:
            return {"cleaned": False, "reason": "not_idle", "activeStreams": active_streams, "idleForSeconds": idle_for}

    unloaded = _unload_runtime(None, include_pinned=include_pinned)
    if not unloaded and not _loaded_models():
        _clear_mlx_cache()
    return {
        "cleaned": True,
        "unloaded": unloaded,
        "count": len(unloaded),
        "activeStreams": 0,
        "idleForSeconds": idle_for,
    }


def _loaded_models() -> list[dict[str, Any]]:
    with _runtime_lock:
        return [
            {
                "name": runtime["modelName"],
                "backend": runtime.get("backend"),
                "pinned": bool(runtime.get("pinned")),
            }
            for runtime in _runtime["loaded"].values()
        ]


def _preload_pinned_models() -> None:
    for spec in MODEL_SPECS.values():
        if not spec.pinned or not model_ready(spec):
            continue
        try:
            _load_runtime(spec.name)
        except Exception as exc:
            print(f"Failed to preload pinned MLX model {spec.name}: {exc}", file=sys.stderr, flush=True)


def _start_pinned_preload() -> None:
    thread = threading.Thread(target=_preload_pinned_models, daemon=True)
    thread.start()


def _idle_watchdog() -> None:
    while True:
        with _runtime_lock:
            check_seconds = max(1.0, float(_runtime.get("idleCheckSeconds") or 30))
            unload_seconds = float(_runtime.get("idleUnloadSeconds") or 0)
        time.sleep(check_seconds)
        if unload_seconds <= 0:
            continue
        try:
            _idle_cleanup(min_idle_seconds=unload_seconds, include_pinned=False)
        except Exception as exc:
            print(f"MLX idle cleanup failed: {exc}", file=sys.stderr, flush=True)


def _start_idle_watchdog() -> None:
    thread = threading.Thread(target=_idle_watchdog, daemon=True)
    thread.start()


def _message_payload(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    payload: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "user")
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        payload.append({
            "role": role if role in {"system", "user", "assistant"} else "user",
            "content": content,
        })
    return payload


def _generation_kwargs(options: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "max_tokens": int(options.get("max_tokens") or options.get("num_predict") or 1024),
        "temperature": float(options.get("temperature") or 0.0),
        "top_p": float(options.get("top_p") or 1.0),
    }
    if options.get("top_k") is not None:
        kwargs["top_k"] = int(options["top_k"])
    if options.get("min_p") is not None:
        kwargs["min_p"] = float(options["min_p"])
    if options.get("repetition_penalty") is not None:
        kwargs["repetition_penalty"] = float(options["repetition_penalty"])
    if options.get("seed") is not None:
        kwargs["seed"] = int(options["seed"])
    kwargs["enable_thinking"] = bool(options.get("enable_thinking", False))
    if options.get("thinking_budget") is not None:
        kwargs["thinking_budget"] = int(options["thinking_budget"])
    return kwargs


def _lm_generation_kwargs(options: dict[str, Any]) -> dict[str, Any]:
    from mlx_lm.sample_utils import make_logits_processors, make_sampler

    kwargs: dict[str, Any] = {
        "max_tokens": int(options.get("max_tokens") or options.get("num_predict") or 1024),
        "sampler": make_sampler(
            temp=float(options.get("temperature") or 0.0),
            top_p=float(options.get("top_p") or 0.0),
            min_p=float(options.get("min_p") or 0.0),
            top_k=int(options.get("top_k") or 0),
        ),
    }
    if options.get("repetition_penalty") is not None:
        kwargs["logits_processors"] = make_logits_processors(
            repetition_penalty=float(options["repetition_penalty"]),
        )
    if options.get("max_kv_size") is not None:
        kwargs["max_kv_size"] = int(options["max_kv_size"])
    if options.get("kv_bits") is not None:
        kwargs["kv_bits"] = int(options["kv_bits"])
    return kwargs


def _chat_template_kwargs(options: dict[str, Any]) -> dict[str, Any]:
    return {
        "enable_thinking": bool(options.get("enable_thinking", False)),
    }


def _apply_lm_chat_template(tokenizer: Any, prompt: Any, options: dict[str, Any]) -> str:
    if not isinstance(prompt, list):
        return str(prompt)
    if getattr(tokenizer, "chat_template", None) is not None:
        try:
            return tokenizer.apply_chat_template(
                prompt,
                tokenize=False,
                add_generation_prompt=True,
                **_chat_template_kwargs(options),
            )
        except TypeError:
            return tokenizer.apply_chat_template(
                prompt,
                tokenize=False,
                add_generation_prompt=True,
            )
    return "\n".join(f"{item['role'].capitalize()}: {item['content']}" for item in prompt) + "\nAssistant:"


@app.get("/health")
async def health() -> dict[str, Any]:
    preflight = _run_mlx_preflight()
    loaded = _loaded_models()
    with _runtime_lock:
        active_streams = int(_runtime.get("activeStreams") or 0)
        idle_for = max(0.0, time.monotonic() - float(_runtime.get("lastActiveAt") or time.monotonic()))
    return {
        "ok": bool(preflight.get("ok")),
        "name": "naow-mlx-runner",
        "version": "0.1.0",
        "modelLoaded": bool(loaded),
        "modelName": loaded[0]["name"] if len(loaded) == 1 else None,
        "loadedModels": loaded,
        "activeStreams": active_streams,
        "idleForSeconds": idle_for,
        "modelsDir": str(MODEL_DIR),
        "preflight": preflight,
    }


@app.get("/models/status")
async def models_status() -> dict[str, Any]:
    payload = download_status()
    payload["models"] = [model_payload(spec) for spec in MODEL_SPECS.values()]
    return payload


@app.get("/runtime/preflight")
async def runtime_preflight() -> dict[str, Any]:
    return _run_mlx_preflight()


@app.post("/models/download")
async def download_model(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return start_download(str((payload or {}).get("modelKey") or DEFAULT_MODEL.key))


@app.get("/models/download/status")
async def model_download_status() -> dict[str, Any]:
    return download_status()


@app.post("/models/load")
async def load_model(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    runtime = _load_runtime(str((payload or {}).get("model") or DEFAULT_MODEL.name))
    return {"loaded": True, "model": runtime["modelName"]}


@app.post("/models/unload")
async def unload_model(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    include_pinned = bool((payload or {}).get("includePinned", False))
    model_name = (payload or {}).get("model")
    unloaded = _unload_runtime(str(model_name) if model_name else None, include_pinned=include_pinned)
    return {"unloaded": unloaded, "count": len(unloaded), "keptLoaded": _loaded_models()}


@app.post("/runtime/prompt-cache/clear")
async def clear_prompt_cache(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    model_name = str((payload or {}).get("model") or "").strip()
    cleared = 0
    with _runtime_lock:
        runtimes = [_runtime["loaded"].get(model_name)] if model_name else list(_runtime["loaded"].values())
        for runtime in runtimes:
            if not runtime:
                continue
            caches = runtime.get("promptCaches")
            if isinstance(caches, dict):
                cleared += len(caches)
                caches.clear()
    return {"cleared": cleared}


@app.post("/runtime/prompt-cache/warm")
async def warm_prompt_cache(payload: dict[str, Any]) -> dict[str, Any]:
    runtime = _load_runtime(str(payload.get("model") or DEFAULT_MODEL.name))
    messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    images = [str(item) for item in payload.get("images", []) if str(item).strip()]
    prompt_messages = _message_payload(messages)
    prompt = prompt_messages or str(payload.get("prompt") or "")
    cache_request = _prompt_cache_request(payload, runtime, images)

    if runtime.get("backend") != "vlm":
        return {
            "warmed": False,
            "enabled": False,
            "hit": False,
            "disabledReason": "backend_unsupported",
        }

    from mlx_vlm.prompt_utils import apply_chat_template

    template_started = time.monotonic()
    templated_prompt = apply_chat_template(
        runtime["processor"],
        runtime["model"].config,
        prompt,
        num_images=len(images),
        **_chat_template_kwargs(options),
    )
    chat_template_ms = round((time.monotonic() - template_started) * 1000, 3)
    result = _warm_vlm_prompt_cache(runtime, templated_prompt, images, options, cache_request)
    result.update({
        "chatTemplateMs": chat_template_ms,
        "promptChars": len(templated_prompt),
        "source": payload.get("source") or None,
    })
    print(
        "prompt-cache-warm",
        _stable_json({
            "model": runtime.get("modelName"),
            "source": result.get("source"),
            "enabled": result.get("enabled"),
            "warmed": result.get("warmed"),
            "hit": result.get("hit"),
            "reusedTokens": result.get("reusedTokens"),
            "newTokens": result.get("newTokens"),
            "disabledReason": result.get("disabledReason"),
            "elapsedMs": result.get("elapsedMs"),
            "key": result.get("key"),
        }),
        file=sys.stderr,
        flush=True,
    )
    return result


@app.post("/runtime/idle-cleanup")
async def runtime_idle_cleanup(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    include_pinned = bool((payload or {}).get("includePinned", False))
    min_idle_seconds = float((payload or {}).get("minIdleSeconds", 0))
    return _idle_cleanup(min_idle_seconds=min_idle_seconds, include_pinned=include_pinned)


@app.post("/runtime/residency")
async def set_residency(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    value = str((payload or {}).get("residency") or "always_hot")
    if value not in {"always_hot", "warm_idle", "unload_after_reply"}:
        raise HTTPException(status_code=400, detail={"code": "invalid_residency", "message": "Invalid residency mode."})
    with _runtime_lock:
        _runtime["residency"] = value
        _runtime["lastActiveAt"] = time.monotonic()
    return {"residency": value}


@app.post("/chat/stream")
async def chat_stream(payload: dict[str, Any]) -> StreamingResponse:
    runtime = _load_runtime(str(payload.get("model") or DEFAULT_MODEL.name))
    messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    images = [str(item) for item in payload.get("images", []) if str(item).strip()]
    prompt_messages = _message_payload(messages)
    prompt = prompt_messages or str(payload.get("prompt") or "")
    cache_request = _prompt_cache_request(payload, runtime, images)

    def generate_events():
        _stream_started()
        try:
            if runtime["backend"] == "vlm":
                from mlx_vlm import stream_generate
                from mlx_vlm.prompt_utils import apply_chat_template

                template_started = time.monotonic()
                model = runtime["model"]
                processor = runtime["processor"]
                templated_prompt = apply_chat_template(
                    processor,
                    model.config,
                    prompt,
                    num_images=len(images),
                    **_chat_template_kwargs(options),
                )
                chat_template_ms = round((time.monotonic() - template_started) * 1000, 3)
                kwargs = _generation_kwargs(options)
                if runtime.get("visionCache") is not None:
                    kwargs["vision_cache"] = runtime["visionCache"]
                with runtime.setdefault("generationLock", threading.RLock()):
                    prompt_cache_state, cache_metrics = _prompt_cache_state(runtime, cache_request)
                    prompt_tokens = None
                    if prompt_cache_state is not None:
                        try:
                            prompt_token_ids = _token_ids_for_prompt(processor, templated_prompt)
                            prompt_tokens = len(prompt_token_ids)
                            prefix_length = prompt_cache_state.find_prefix_length(prompt_token_ids)
                            cache_metrics["hit"] = prefix_length > 0
                            cache_metrics["reusedTokens"] = prefix_length
                            cache_metrics["newTokens"] = max(0, len(prompt_token_ids) - prefix_length)
                            kwargs["prompt_cache_state"] = prompt_cache_state
                        except Exception as exc:
                            cache_metrics = {
                                "enabled": False,
                                "hit": False,
                                "disabledReason": f"tokenize_failed:{exc}",
                            }
                    yield json.dumps({
                        "type": "meta",
                        "chatTemplateMs": chat_template_ms,
                        "promptChars": len(templated_prompt),
                        "promptTokens": prompt_tokens,
                        "promptCache": cache_metrics,
                    }) + "\n"
                    print(
                        "prompt-cache",
                        _stable_json({
                            "model": runtime.get("modelName"),
                            "enabled": cache_metrics.get("enabled"),
                            "hit": cache_metrics.get("hit"),
                            "reusedTokens": cache_metrics.get("reusedTokens"),
                            "newTokens": cache_metrics.get("newTokens"),
                            "disabledReason": cache_metrics.get("disabledReason"),
                            "key": cache_metrics.get("key"),
                        }),
                        file=sys.stderr,
                        flush=True,
                    )
                    for chunk in stream_generate(model, processor, templated_prompt, image=images or None, **kwargs):
                        text = getattr(chunk, "text", "")
                        if text:
                            yield json.dumps({"type": "token", "delta": text}) + "\n"
            else:
                from mlx_lm import stream_generate

                if images:
                    raise ValueError(f"{runtime['modelName']} does not support image inputs.")
                template_started = time.monotonic()
                tokenizer = runtime["tokenizer"]
                templated_prompt = _apply_lm_chat_template(tokenizer, prompt, options)
                chat_template_ms = round((time.monotonic() - template_started) * 1000, 3)
                yield json.dumps({
                    "type": "meta",
                    "chatTemplateMs": chat_template_ms,
                    "promptChars": len(templated_prompt),
                    "promptTokens": None,
                    "promptCache": {
                        "enabled": False,
                        "hit": False,
                        "disabledReason": "backend_unsupported",
                    },
                }) + "\n"
                kwargs = _lm_generation_kwargs(options)
                for chunk in stream_generate(runtime["model"], tokenizer, templated_prompt, **kwargs):
                    text = getattr(chunk, "text", "")
                    if text:
                        yield json.dumps({"type": "token", "delta": text}) + "\n"
            yield json.dumps({"type": "done", "doneReason": "stop"}) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        finally:
            residency = str(_runtime.get("residency") or "always_hot")
            if residency == "unload_after_reply" and not runtime.get("pinned"):
                _unload_runtime(runtime["modelName"])
            elif residency == "warm_idle":
                if not runtime.get("pinned"):
                    with _runtime_lock:
                        if runtime.get("visionCache") is not None:
                            runtime["visionCache"] = None
                    _clear_mlx_cache()
            _stream_finished()

    return StreamingResponse(generate_events(), media_type="application/x-ndjson")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("NAOW_MLX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NAOW_MLX_PORT", "5055")))
    args = parser.parse_args()
    ensure_dirs()
    import uvicorn
    _start_pinned_preload()
    _start_idle_watchdog()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
