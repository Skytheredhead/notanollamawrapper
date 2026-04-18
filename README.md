# naow

Local chat app for `notanollamawrapper`, visible name `naow`.

The backend talks to local Ollama models, persists chats in SQLite, exposes a JSON/SSE API, and serves the built Vite frontend from `frontend/dist`. The search endpoint is intentionally not implemented yet; the reminder lives in `frontend/BACKEND_SEARCH_TODO.md`.

## Requirements

- Node.js 22+
- Ollama running locally
- Apple Silicon Mac for the MLX runner
- Python 3.11+ for MLX setup

## Install

```bash
npm install
npm --prefix frontend install
```

Optional MLX runner setup:

```bash
npm run setup:mlx
```

The setup command creates `.naow/mlx-venv` and installs the Python sidecar dependencies. Restart the backend after setup so it can auto-start the runner.

## Start Ollama

```bash
ollama serve
ollama pull llama3.2
```

## Run App

Backend development:

```bash
npm run dev
```

Frontend development:

```bash
npm run dev:frontend
```

The Vite dev server runs on `http://127.0.0.1:5173` and proxies `/api` and `/health` to the backend at `http://127.0.0.1:5050`.

Production-style local run with the frontend served by Fastify:

```bash
npm run build:frontend
npm start
```

API-only local run:

```bash
npm start
```

Default backend base URL:

```text
http://127.0.0.1:5050
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind host. |
| `PORT` | `5050` | Bind port. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama HTTP API URL. |
| `OLLAMA_API_KEY` | empty | Enables Ollama web search when the Settings toggle allows it. |
| `OLLAMA_WEB_SEARCH_URL` | `https://ollama.com/api/web_search` | Ollama web search endpoint. |
| `NAOW_DATA_DIR` | `.naow` | Local data directory when `NAOW_DB_PATH` is unset. |
| `NAOW_DB_PATH` | empty | Explicit SQLite file path. Wins over `NAOW_DATA_DIR`. |
| `NAOW_DEFAULT_MODEL` | empty | Optional fallback model for generation requests. |
| `NAOW_CORS_ORIGIN` | `*` | CORS origin for local frontend development. |
| `NAOW_OLLAMA_TIMEOUT_MS` | `5000` | Timeout for health/model-list Ollama checks. |
| `NAOW_WEB_SEARCH_MAX_RESULTS` | `5` | Maximum Ollama web search results injected into model context. |
| `NAOW_FRONTEND_DIST` | `frontend/dist` | Built frontend directory served by the backend. |
| `NAOW_MLX_BASE_URL` | `http://127.0.0.1:5055` | MLX sidecar URL. |
| `NAOW_MLX_MODEL` | `mlx-community/Qwen3.5-9B-MLX-4bit` | First MLX model. |
| `NAOW_MLX_RESIDENCY` | `always_hot` | Default MLX model residency. |
| `NAOW_MLX_AUTOSTART` | `true` | Auto-start the Python MLX sidecar when the backend starts. |
| `NAOW_MLX_PYTHON` | `.naow/mlx-venv/bin/python` | Python executable used for the sidecar. |

### MLX Model Download

The app prompts to download supported MLX models when the runner is available and files are missing. Models are stored in the naow app data models directory instead of relying on the global Hugging Face cache.

Supported MLX models:

- `mlx-community/Qwen3.5-9B-MLX-4bit` - pinned and kept loaded.
- `Jiunsong/supergemma4-26b-uncensored-mlx-4bit-v2` - pinned and kept loaded after download.
- `mlx-community/gpt-oss-20b-MXFP4-Q8` - loaded on demand.
- `mlx-community/Qwen3-0.6B-4bit-DWQ-053125` - loaded on demand.

The sidecar runs an MLX native preflight in a child process before loading a model. If MLX/Metal crashes during import, `/api/mlx/preflight` and `/health` report the failure without taking down the sidecar.

Frontend environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | API base URL used by the Vite client. |
| `VITE_USE_MOCK` | `false` | Set to `true` to use the mock adapter instead of the backend. |

The default SQLite database path is:

```text
.naow/naow.sqlite
```

## Endpoints

### Health

```bash
curl http://127.0.0.1:5050/health
```

Response:

```json
{
  "ok": true,
  "name": "naow",
  "version": "0.1.0",
  "uptimeMs": 1234,
  "db": {
    "ok": true
  },
  "ollama": {
    "ok": true,
    "url": "http://127.0.0.1:11434",
    "version": "0.20.7"
  }
}
```

If Ollama is down, the backend still reports its own health and returns `ollama.ok=false`.

### List Ollama Models

```bash
curl http://127.0.0.1:5050/api/models
```

Response:

```json
{
  "models": [
    {
      "name": "llama3.2:latest",
      "modifiedAt": "2026-04-17T12:00:00.000Z",
      "size": 2019393189,
      "digest": "abc123",
      "details": {
        "family": "llama",
        "parameterSize": "3.2B",
        "quantizationLevel": "Q4_K_M"
      }
    }
  ]
}
```

### Unload Ollama Models

Unload currently running Ollama models from memory:

```bash
curl -X POST http://127.0.0.1:5050/api/models/unload
```

Response:

```json
{
  "unloaded": ["llama3.2:latest"],
  "count": 1
}
```

### Create Chat

```bash
curl -X POST http://127.0.0.1:5050/api/chats \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Local model notes",
    "model": "llama3.2:latest",
    "systemPrompt": "Answer concisely."
  }'
```

All request fields are optional. Defaults:

- `title`: `New chat`
- `model`: `null`
- `systemPrompt`: `null`

Response:

```json
{
  "chat": {
    "id": "8c8f0af8-b8c1-49bb-9ea2-78cf2676d3f6",
    "title": "Local model notes",
    "model": "llama3.2:latest",
    "systemPrompt": "Answer concisely.",
    "createdAt": "2026-04-17T19:00:00.000Z",
    "updatedAt": "2026-04-17T19:00:00.000Z"
  }
}
```

### List Chats

```bash
curl 'http://127.0.0.1:5050/api/chats?limit=50'
```

Response:

```json
{
  "chats": [
    {
      "id": "8c8f0af8-b8c1-49bb-9ea2-78cf2676d3f6",
      "title": "Local model notes",
      "model": "llama3.2:latest",
      "createdAt": "2026-04-17T19:00:00.000Z",
      "updatedAt": "2026-04-17T19:05:00.000Z",
      "messageCount": 4,
      "lastMessagePreview": "The fastest option is..."
    }
  ],
  "nextCursor": null
}
```

Use `nextCursor` as the `cursor` query value for the next page.

### Load Chat

```bash
curl http://127.0.0.1:5050/api/chats/8c8f0af8-b8c1-49bb-9ea2-78cf2676d3f6
```

Response:

```json
{
  "chat": {
    "id": "8c8f0af8-b8c1-49bb-9ea2-78cf2676d3f6",
    "title": "Local model notes",
    "model": "llama3.2:latest",
    "systemPrompt": "Answer concisely.",
    "createdAt": "2026-04-17T19:00:00.000Z",
    "updatedAt": "2026-04-17T19:05:00.000Z"
  },
  "messages": [
    {
      "id": "f7a1",
      "chatId": "8c8f0af8-b8c1-49bb-9ea2-78cf2676d3f6",
      "role": "user",
      "content": "What models are installed?",
      "status": "complete",
      "generationId": null,
      "error": null,
      "createdAt": "2026-04-17T19:01:00.000Z",
      "updatedAt": "2026-04-17T19:01:00.000Z",
      "completedAt": "2026-04-17T19:01:00.000Z"
    }
  ]
}
```

By default, regenerated messages marked `replaced` are excluded. Include them with:

```bash
curl 'http://127.0.0.1:5050/api/chats/CHAT_ID?includeReplaced=true'
```

### Send Message And Stream Reply

```bash
curl -N -X POST http://127.0.0.1:5050/api/chats/CHAT_ID/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Explain SQLite WAL mode in one paragraph.",
    "model": "llama3.2:latest",
    "webSearch": true,
    "options": {
      "temperature": 0.7,
      "num_predict": 512
    }
  }'
```

Rules:

- `content` is required.
- `model` overrides the chat model for this generation.
- If `model` is provided and the chat has no model, the backend saves it to the chat.
- `options` is passed to Ollama.
- `webSearch` defaults to `true`; actual web search requires `OLLAMA_API_KEY`.
- One active generation per chat is allowed.

### Stop Generation By Chat

```bash
curl -X POST http://127.0.0.1:5050/api/chats/CHAT_ID/stop
```

Response:

```json
{
  "stopped": true,
  "chatId": "CHAT_ID",
  "generationId": "gen_8f9"
}
```

If nothing is active:

```json
{
  "stopped": false,
  "chatId": "CHAT_ID"
}
```

### Stop Generation By Generation ID

```bash
curl -X POST http://127.0.0.1:5050/api/generations/gen_8f9/stop
```

Response:

```json
{
  "stopped": true,
  "generationId": "gen_8f9"
}
```

### Regenerate Latest Assistant Reply

```bash
curl -N -X POST http://127.0.0.1:5050/api/chats/CHAT_ID/regenerate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "llama3.2:latest",
    "options": {
      "temperature": 0.8
    }
  }'
```

The previous latest assistant message is marked `replaced`, and the replacement streams with the same SSE format as a normal message.

## Streaming Format

Streaming responses use Server-Sent Events:

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

The backend normalizes Ollama chunks. The frontend never needs to parse raw Ollama NDJSON.

### `generation_start`

```text
event: generation_start
data: {"chatId":"8c8","assistantMessageId":"91bd","generationId":"gen_8f9","model":"llama3.2:latest","createdAt":"2026-04-17T19:01:01.000Z"}
```

### `token`

```text
event: token
data: {"delta":"SQLite"}
```

### `message_complete`

```text
event: message_complete
data: {"message":{"id":"91bd","chatId":"8c8","role":"assistant","content":"SQLite WAL mode...","status":"complete","generationId":"gen_8f9","error":null,"createdAt":"2026-04-17T19:01:01.000Z","updatedAt":"2026-04-17T19:01:04.000Z","completedAt":"2026-04-17T19:01:04.000Z"},"doneReason":"stop"}
```

### `cancelled`

```text
event: cancelled
data: {"message":{"id":"91bd","chatId":"8c8","role":"assistant","content":"SQLite WAL mode lets","status":"cancelled","generationId":"gen_8f9","error":null,"createdAt":"2026-04-17T19:01:01.000Z","updatedAt":"2026-04-17T19:01:02.000Z","completedAt":"2026-04-17T19:01:02.000Z"},"reason":"user_stopped"}
```

Reasons:

- `user_stopped`
- `client_disconnected`
- `server_shutdown`

### `error`

```text
event: error
data: {"error":{"code":"ollama_stream_failed","message":"Ollama stream ended unexpectedly."}}
```

### `ping`

Sent every 15 seconds while generation is active:

```text
event: ping
data: {"time":"2026-04-17T19:01:15.000Z"}
```

## Fetch Stream Example

Framework-agnostic browser example:

```js
const response = await fetch('http://127.0.0.1:5050/api/chats/CHAT_ID/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    content: 'Say hello',
    model: 'llama3.2:latest'
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() || '';

  for (const frame of frames) {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || '{}');

    if (event === 'token') {
      console.log(data.delta);
    }
  }
}
```

## Persistence Notes

- SQLite uses WAL mode.
- Normal database path is `.naow/naow.sqlite`.
- User messages are inserted before Ollama generation starts.
- Assistant messages are inserted as `streaming`.
- Token chunks are buffered in memory.
- The backend does not write to SQLite for every token.
- On complete, cancel, or error, the assistant message is finalized with one DB update.
- Cancelled messages keep partial content.
- Error messages keep partial content and an error string.

## Error Shape

```json
{
  "error": {
    "code": "string_code",
    "message": "Human-readable message"
  }
}
```

Common statuses:

- `400`: invalid input or missing model
- `404`: chat not found
- `409`: generation already in progress
- `503`: Ollama unavailable
- `500`: unexpected backend error

## Tests

```bash
npm test
```
