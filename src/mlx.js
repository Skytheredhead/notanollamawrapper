import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { OllamaStreamError, OllamaUnavailableError } from './ollama.js';

export class MlxUnavailableError extends Error {
  constructor(baseUrl, cause) {
    super(`Could not reach MLX runner at ${baseUrl}`);
    this.name = 'MlxUnavailableError';
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

export class MlxStreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MlxStreamError';
    this.cause = cause;
  }
}

function timeoutSignal(timeoutMs) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort('timeout'), timeoutMs);
  return {
    signal: abortController.signal,
    clear: () => clearTimeout(timer)
  };
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text);
}

function messageFromErrorBody(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const detail = parsed.detail || parsed.error || parsed;
    if (typeof detail === 'string') return detail;
    return detail.message || detail.code || body;
  } catch {
    return body;
  }
}

function normalizeModel(model) {
  return {
    name: model.name,
    label: model.label || model.name,
    ready: Boolean(model.ready),
    modifiedAt: null,
    size: model.sizeBytes ?? null,
    digest: null,
    backend: model.backend || 'mlx',
    pinned: Boolean(model.pinned),
    details: model.details || {
      family: 'mlx',
      parameterSize: null,
      quantizationLevel: null
    }
  };
}

function imagePathsFromMessages(messages = []) {
  const paths = [];
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      if (attachment?.type === 'image' && attachment.path) {
        paths.push(attachment.path);
      }
    }
  }
  return paths;
}

export class MlxClient {
  constructor({ baseUrl, timeoutMs = 5000, modelName, residency = 'always_hot', fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.modelName = modelName;
    this.residency = residency;
    this.fetch = fetchImpl;
  }

  isMlxModel(model) {
    const value = String(model || '');
    return !model || model === this.modelName || value.includes('/');
  }

  async getVersion() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/health`, { signal: timeout.signal });
      if (!response.ok) throw new Error(`MLX runner returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      throw new MlxUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async status() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/models/status`, { signal: timeout.signal });
      if (!response.ok) throw new Error(`MLX runner returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      throw new MlxUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async preflight() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/runtime/preflight`, { signal: timeout.signal });
      if (!response.ok) throw new Error(`MLX runner returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      throw new MlxUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async listModels() {
    const payload = await this.status();
    return (payload.models || []).map(normalizeModel);
  }

  async startModelDownload(modelKey) {
    const response = await this.fetch(`${this.baseUrl}/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelKey })
    });
    if (!response.ok) throw new Error(`MLX download returned HTTP ${response.status}`);
    return response.json();
  }

  async modelDownloadStatus() {
    const response = await this.fetch(`${this.baseUrl}/models/download/status`);
    if (!response.ok) throw new Error(`MLX download status returned HTTP ${response.status}`);
    return response.json();
  }

  async setResidency(residency = this.residency) {
    const response = await this.fetch(`${this.baseUrl}/runtime/residency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ residency })
    });
    if (!response.ok) return null;
    return response.json();
  }

  async completeChat({ model, messages, options, signal }) {
    let content = '';
    let doneReason = 'stop';
    for await (const chunk of this.streamChat({
      model,
      messages,
      options: {
        ...(options || {}),
        max_tokens: Math.min(Number(options?.max_tokens || options?.num_predict || 256), 512)
      },
      signal
    })) {
      if (chunk.type === 'token') content += chunk.delta;
      if (chunk.type === 'done') doneReason = chunk.doneReason || 'stop';
    }
    return {
      message: {
        role: 'assistant',
        content
      },
      doneReason
    };
  }

  async unloadLoadedModels({ includePinnedMlx = false } = {}) {
    const response = await this.fetch(`${this.baseUrl}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includePinned: includePinnedMlx })
    });
    if (!response.ok) throw new Error(`MLX unload returned HTTP ${response.status}`);
    return response.json();
  }

  async clearPromptCache({ model } = {}) {
    const response = await this.fetch(`${this.baseUrl}/runtime/prompt-cache/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!response.ok) return null;
    return response.json();
  }

  async *streamChat({ model, messages, options, signal, cache }) {
    const images = imagePathsFromMessages(messages);
    const targetModel = this.isMlxModel(model) ? (model || this.modelName) : this.modelName;
    let response;
    try {
      await this.setResidency(options?.residency || this.residency);
      response = await this.fetch(`${this.baseUrl}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          messages,
          images,
          options,
          cache
        }),
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MlxStreamError(`Could not reach MLX runner at ${this.baseUrl}`, error);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const message = messageFromErrorBody(body);
      throw new MlxStreamError(`MLX runner returned HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }
    if (!response.body) throw new MlxStreamError('MLX response did not include a stream body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const chunk = JSON.parse(trimmed);
          if (chunk.type === 'error' || chunk.error) throw new MlxStreamError(chunk.message || chunk.error);
          if (chunk.type === 'meta') yield { type: 'meta', ...chunk };
          if (chunk.delta) yield { type: 'token', delta: chunk.delta };
          if (chunk.type === 'done' || chunk.done) {
            sawDone = true;
            yield { type: 'done', doneReason: chunk.doneReason || 'stop' };
          }
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const chunk = JSON.parse(tail);
        if (chunk.type === 'error' || chunk.error) throw new MlxStreamError(chunk.message || chunk.error);
        if (chunk.type === 'meta') yield { type: 'meta', ...chunk };
        if (chunk.delta) yield { type: 'token', delta: chunk.delta };
        if (chunk.type === 'done' || chunk.done) {
          sawDone = true;
          yield { type: 'done', doneReason: chunk.doneReason || 'stop' };
        }
      }
      if (!sawDone && !signal?.aborted) throw new MlxStreamError('MLX stream ended unexpectedly.');
    } finally {
      reader.releaseLock();
    }
  }
}

export class HybridModelClient {
  constructor({ mlx, ollama }) {
    this.mlx = mlx;
    this.ollama = ollama;
  }

  canWebSearch() {
    return this.ollama?.canWebSearch?.() || false;
  }

  async getVersion() {
    const payload = { provider: 'mlx', mlx: null, ollama: null };
    try {
      payload.mlx = await this.mlx.getVersion();
    } catch (error) {
      payload.mlx = { ok: false, error: error.cause?.message || error.message };
    }
    try {
      payload.ollama = await this.ollama.getVersion();
    } catch (error) {
      payload.ollama = { ok: false, error: error.cause?.message || error.message };
    }
    return payload;
  }

  async listModels() {
    const models = [];
    try {
      models.push(...await this.mlx.listModels());
    } catch {
      // MLX status has a dedicated endpoint; keep model listing useful when only Ollama is up.
    }
    try {
      models.push(...await this.ollama.listModels());
    } catch {
      // Health reports provider availability in detail.
    }
    return models;
  }

  async webSearch(...args) {
    return this.ollama.webSearch(...args);
  }

  async completeChat(request) {
    if (this.mlx?.isMlxModel?.(request?.model)) {
      return this.mlx.completeChat(request);
    }
    return this.ollama.completeChat(request);
  }

  async unloadLoadedModels(options = {}) {
    const unloaded = [];
    let count = 0;
    try {
      const result = await this.mlx.unloadLoadedModels(options);
      unloaded.push(...(result.unloaded || []));
      count += result.count || result.unloaded?.length || 0;
    } catch {
      // Best effort: still let Ollama unload.
    }
    try {
      const result = await this.ollama.unloadLoadedModels();
      unloaded.push(...(result.unloaded || []));
      count += result.count || result.unloaded?.length || 0;
    } catch {
      // Keep response successful if at least MLX was handled.
    }
    return { unloaded: unloaded.filter(Boolean), count };
  }

  async clearPromptCache(options = {}) {
    return this.mlx?.clearPromptCache?.(options) || null;
  }

  backendForModel(model) {
    if (this.mlx?.isMlxModel?.(model)) {
      return {
        id: 'mlx',
        label: 'MLX'
      };
    }
    return {
      id: 'ollama',
      label: 'Ollama'
    };
  }

  async *streamChat(request) {
    const hasImages = request.messages?.some((message) => message.attachments?.length);
    if (hasImages || this.mlx.isMlxModel(request.model)) {
      yield* this.mlx.streamChat(request);
      return;
    }

    let yielded = false;
    try {
      for await (const chunk of this.ollama.streamChat(request)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      if (yielded || !(error instanceof OllamaStreamError || error instanceof OllamaUnavailableError)) {
        throw error;
      }
      yield* this.mlx.streamChat({
        ...request,
        model: this.mlx.modelName,
        options: {
          ...(request.options || {}),
          fallbackFrom: request.model
        }
      });
    }
  }
}

export class MlxSidecar {
  constructor({ python, cwd, port = 5055, autostart = true, home = null }) {
    this.python = python;
    this.cwd = cwd;
    this.port = port;
    this.autostart = autostart;
    this.home = home;
    this.process = null;
  }

  start() {
    if (!this.autostart || this.process) return;
    if (!fs.existsSync(this.python)) return;
    this.process = spawn(this.python, ['-m', 'mlx_runner.server', '--port', String(this.port)], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...(this.home ? { NAOW_MLX_HOME: this.home } : {}),
        PYTHONPATH: this.cwd
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process.stdout?.on('data', (chunk) => process.stdout.write(`[mlx] ${chunk}`));
    this.process.stderr?.on('data', (chunk) => process.stderr.write(`[mlx] ${chunk}`));
    this.process.on('exit', () => {
      this.process = null;
    });
  }

  stop() {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
  }
}
