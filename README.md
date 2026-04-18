# naow - not an ollama wrapper

Optimized for speed and doesn't rely on Ollama or any other app behind the scenes.

## features
- Automatic model downloads (courtesy of my other project, Stemsplat)
- Cool UI
- Nerd numbers for nerds
- Local web search with a native Python SearXNG sidecar, no relying on Docker or Ollama
- Keeps pinned models hot cause I have the ram and I don't like waiting
- Built-in tools so you can time your mile - unlike chatgpt/claude/grok/everyone else
- Image chat support for compatible models

## Requirements

- Node.js 22+
- Apple Silicon Mac
- Python 3.11+ for MLX setup

The Vite dev server runs on `http://127.0.0.1:5173` and proxies `/api` and `/health` to the backend at `http://127.0.0.1:5050`.

### Current models:

- `mlx-community/Qwen3.5-9B-MLX-4bit` - pinned and kept loaded.
- `Jiunsong/supergemma4-26b-uncensored-mlx-4bit-v2` - pinned and kept loaded after download.
- `mlx-community/gpt-oss-20b-MXFP4-Q8` - loaded on demand.
- `mlx-community/Qwen3-0.6B-4bit-DWQ-053125` - loaded on demand.
