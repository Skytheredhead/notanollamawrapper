export class OllamaUnavailableError extends Error {
  constructor(baseUrl, cause) {
    super(`Could not reach Ollama at ${baseUrl}`);
    this.name = 'OllamaUnavailableError';
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

export class OllamaStreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OllamaStreamError';
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

function normalizeDetails(details = {}) {
  return {
    family: details.family ?? null,
    parameterSize: details.parameter_size ?? details.parameterSize ?? null,
    quantizationLevel: details.quantization_level ?? details.quantizationLevel ?? null
  };
}

function normalizeModel(model) {
  return {
    name: model.name,
    modifiedAt: model.modified_at ? new Date(model.modified_at).toISOString() : null,
    size: model.size ?? null,
    digest: model.digest ?? null,
    details: normalizeDetails(model.details)
  };
}

export class OllamaClient {
  constructor({ baseUrl, timeoutMs = 5000, apiKey = null, webSearchUrl = 'https://ollama.com/api/web_search', fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.apiKey = apiKey;
    this.webSearchUrl = webSearchUrl;
    this.fetch = fetchImpl;
  }

  canWebSearch() {
    return Boolean(this.apiKey);
  }

  async getVersion() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/version`, {
        signal: timeout.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      throw new OllamaUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async listModels() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/tags`, {
        signal: timeout.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      return (payload.models || []).map(normalizeModel);
    } catch (error) {
      throw new OllamaUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async listRunningModels() {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/ps`, {
        signal: timeout.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      return (payload.models || []).map(normalizeModel);
    } catch (error) {
      throw new OllamaUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async unloadModel(model) {
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: 0
        }),
        signal: timeout.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
      return await response.json().catch(() => ({}));
    } catch (error) {
      throw new OllamaUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }

  async unloadLoadedModels() {
    const running = await this.listRunningModels();
    const names = [...new Set(running.map((model) => model.name).filter(Boolean))];
    for (const name of names) {
      await this.unloadModel(name);
    }
    return {
      unloaded: names,
      count: names.length
    };
  }

  async webSearch(query, { maxResults = 5, signal } = {}) {
    if (!this.apiKey) {
      return { results: [], skipped: 'missing_api_key' };
    }

    const timeout = timeoutSignal(this.timeoutMs);
    const requestSignal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout.signal, signal].filter(Boolean))
      : (signal || timeout.signal);

    try {
      const response = await this.fetch(this.webSearchUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          max_results: maxResults
        }),
        signal: requestSignal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama web search returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }

      const payload = await response.json();
      return {
        results: (payload.results || []).map((result) => ({
          title: result.title || '',
          url: result.url || '',
          content: result.content || ''
        })).filter((result) => result.title || result.url || result.content)
      };
    } finally {
      timeout.clear();
    }
  }

  async *streamChat({ model, messages, options, signal }) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages,
          options: options || undefined
        }),
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OllamaStreamError(`Could not reach Ollama at ${this.baseUrl}`, error);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OllamaStreamError(`Ollama returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }

    if (!response.body) {
      throw new OllamaStreamError('Ollama response did not include a stream body.');
    }

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

          if (chunk.error) {
            throw new OllamaStreamError(chunk.error);
          }

          const delta = chunk.message?.content;
          if (delta) {
            yield { type: 'token', delta };
          }

          if (chunk.done) {
            sawDone = true;
            yield {
              type: 'done',
              doneReason: chunk.done_reason || chunk.doneReason || 'stop'
            };
          }
        }
      }

      const tail = buffer.trim();
      if (tail) {
        const chunk = JSON.parse(tail);
        if (chunk.error) {
          throw new OllamaStreamError(chunk.error);
        }
        const delta = chunk.message?.content;
        if (delta) {
          yield { type: 'token', delta };
        }
        if (chunk.done) {
          sawDone = true;
          yield {
            type: 'done',
            doneReason: chunk.done_reason || chunk.doneReason || 'stop'
          };
        }
      }

      if (!sawDone && !signal?.aborted) {
        throw new OllamaStreamError('Ollama stream ended unexpectedly.');
      }
    } finally {
      reader.releaseLock();
    }
  }

  async completeChat({ model, messages, tools, options, signal }) {
    const timeout = timeoutSignal(this.timeoutMs);
    const requestSignal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout.signal, signal].filter(Boolean))
      : (signal || timeout.signal);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          tools: tools?.length ? tools : undefined,
          options: options || undefined
        }),
        signal: requestSignal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new OllamaStreamError(`Ollama returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof OllamaStreamError) throw error;
      throw new OllamaUnavailableError(this.baseUrl, error);
    } finally {
      timeout.clear();
    }
  }
}
