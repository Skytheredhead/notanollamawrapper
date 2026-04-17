# naow backend

Backend-only local HTTP API for `notanollamawrapper`, visible name `naow`.

This server talks to local Ollama models, persists chats in SQLite, and exposes a frontend-agnostic JSON/SSE API. It does not include frontend UI, HTML pages, bundled client assets, auth, cloud providers, RAG, tools, plugins, or file uploads.

## Requirements

- Node.js 22+
- Ollama running locally

## Install

```bash
npm install
```

## Start Ollama

```bash
ollama serve
ollama pull llama3.2
```

## Run Backend

Development:

```bash
npm run dev
```

Production-style local run:

```bash
npm start
```

Default base URL:

```text
http://127.0.0.1:5050
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind host. |
| `PORT` | `5050` | Bind port. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama HTTP API URL. |
| `NAOW_DATA_DIR` | `.naow` | Local data directory when `NAOW_DB_PATH` is unset. |
| `NAOW_DB_PATH` | empty | Explicit SQLite file path. Wins over `NAOW_DATA_DIR`. |
| `NAOW_DEFAULT_MODEL` | empty | Optional fallback model for generation requests. |
| `NAOW_CORS_ORIGIN` | `*` | CORS origin for local frontend development. |
| `NAOW_OLLAMA_TIMEOUT_MS` | `5000` | Timeout for health/model-list Ollama checks. |

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
