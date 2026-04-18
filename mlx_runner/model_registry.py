from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

from .app_paths import MODEL_DIR

QWEN_REPO = "mlx-community/Qwen3.5-9B-MLX-4bit"
QWEN_KEY = "qwen3_5_9b_mlx_4bit"
SUPERGEMMA_REPO = "Jiunsong/supergemma4-26b-uncensored-mlx-4bit-v2"
SUPERGEMMA_KEY = "supergemma4_26b_uncensored_mlx_4bit_v2"
GPT_OSS_REPO = "mlx-community/gpt-oss-20b-MXFP4-Q8"
GPT_OSS_KEY = "gpt_oss_20b_mxfp4_q8"
QWEN_SMALL_REPO = "mlx-community/Qwen3-0.6B-4bit-DWQ-053125"
QWEN_SMALL_KEY = "qwen3_0_6b_4bit_dwq_053125"


@dataclass(frozen=True)
class ModelSpec:
    key: str
    name: str
    label: str
    repo_id: str
    local_dir_name: str
    family: str
    parameter_size: str
    quantization: str
    backend: str = "lm"
    pinned: bool = False

    @property
    def path(self) -> Path:
        return MODEL_DIR / self.local_dir_name


MODEL_SPECS = {
    QWEN_KEY: ModelSpec(
        key=QWEN_KEY,
        name=QWEN_REPO,
        label="Qwen3.5 9B MLX 4-bit",
        repo_id=QWEN_REPO,
        local_dir_name="mlx-community--Qwen3.5-9B-MLX-4bit",
        family="qwen-vl",
        parameter_size="9B",
        quantization="4bit",
        backend="vlm",
        pinned=True,
    ),
    SUPERGEMMA_KEY: ModelSpec(
        key=SUPERGEMMA_KEY,
        name=SUPERGEMMA_REPO,
        label="SuperGemma4 26B Uncensored MLX 4-bit",
        repo_id=SUPERGEMMA_REPO,
        local_dir_name="Jiunsong--supergemma4-26b-uncensored-mlx-4bit-v2",
        family="gemma4",
        parameter_size="26B",
        quantization="4bit",
        backend="vlm",
        pinned=False,
    ),
    GPT_OSS_KEY: ModelSpec(
        key=GPT_OSS_KEY,
        name=GPT_OSS_REPO,
        label="GPT-OSS 20B MLX MXFP4 Q8",
        repo_id=GPT_OSS_REPO,
        local_dir_name="mlx-community--gpt-oss-20b-MXFP4-Q8",
        family="gpt-oss",
        parameter_size="20B",
        quantization="MXFP4-Q8",
        backend="lm",
    ),
    QWEN_SMALL_KEY: ModelSpec(
        key=QWEN_SMALL_KEY,
        name=QWEN_SMALL_REPO,
        label="Qwen3 0.6B MLX 4-bit DWQ",
        repo_id=QWEN_SMALL_REPO,
        local_dir_name="mlx-community--Qwen3-0.6B-4bit-DWQ-053125",
        family="qwen3",
        parameter_size="0.6B",
        quantization="4bit-DWQ",
        backend="lm",
        pinned=True,
    ),
}

DEFAULT_MODEL_KEY = QWEN_KEY
DEFAULT_MODEL = MODEL_SPECS[DEFAULT_MODEL_KEY]


def spec_for_name(name: str | None) -> ModelSpec:
    if not name:
        return DEFAULT_MODEL
    for spec in MODEL_SPECS.values():
        if name in {spec.key, spec.name, spec.label, spec.local_dir_name}:
            return spec
    raise KeyError(name)


def _indexed_weights_ready(path: Path) -> bool | None:
    index_files = list(path.glob("*.safetensors.index.json")) + list(path.glob("*.bin.index.json"))
    if not index_files:
        return None
    expected: set[str] = set()
    for index_file in index_files:
        try:
            payload = json.loads(index_file.read_text())
        except Exception:
            return False
        expected.update(str(name) for name in (payload.get("weight_map") or {}).values())
    if not expected:
        return False
    return all((path / name).is_file() for name in expected)


def model_ready(spec: ModelSpec) -> bool:
    path = spec.path
    if not path.is_dir() or not (path / "config.json").is_file():
        return False
    if any(path.rglob("*.part")):
        return False

    indexed_ready = _indexed_weights_ready(path)
    weights_ready = indexed_ready if indexed_ready is not None else any(
        any(path.rglob(pattern))
        for pattern in ("*.safetensors", "*.bin", "*.gguf")
    )
    tokenizer_ready = any(
        (path / name).is_file()
        for name in ("tokenizer.json", "tokenizer.model", "vocab.json")
    )
    return bool(weights_ready and tokenizer_ready)


def model_size_bytes(spec: ModelSpec) -> int:
    if not spec.path.exists():
        return 0
    total = 0
    for child in spec.path.rglob("*"):
        if child.is_file():
            try:
                total += max(0, child.stat().st_size)
            except OSError:
                pass
    return total


def model_payload(spec: ModelSpec) -> dict:
    ready = model_ready(spec)
    return {
        "key": spec.key,
        "name": spec.name,
        "label": spec.label,
        "ready": ready,
        "path": str(spec.path) if ready else "",
        "backend": spec.backend,
        "pinned": spec.pinned,
        "sizeBytes": model_size_bytes(spec) if ready else None,
        "details": {
            "family": spec.family,
            "parameterSize": spec.parameter_size,
            "quantizationLevel": spec.quantization,
        },
    }
