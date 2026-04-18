import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDatabase } from '../src/db.js';
import { GenerationManager } from '../src/generation-manager.js';
import { MlxStreamError } from '../src/mlx.js';

function parseSse(text) {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      return {
        event,
        data: data ? JSON.parse(data) : null
      };
    });
}

function makeHarness(env = {}, ollamaOverrides = {}, searchClient = null, extras = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naow-routes-'));
  const config = loadConfig({
    NAOW_DB_PATH: path.join(dir, 'test.sqlite'),
    OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    ...env
  }, dir);
  const db = new LocalDatabase(config.dbPath);
  const ollama = {
    async getVersion() {
      return { version: 'mock' };
    },
    async listModels() {
      return [
        {
          name: 'llama3.2:latest',
          modifiedAt: '2026-04-17T12:00:00.000Z',
          size: 123,
          digest: 'abc',
          details: {
            family: 'llama',
            parameterSize: '3B',
            quantizationLevel: 'Q4'
          }
        }
      ];
    },
    ...ollamaOverrides
  };
  const app = buildApp({
    config,
    db,
    ollama,
    generationManager: new GenerationManager(),
    searchClient,
    ...extras
  });

  return {
    app,
    db,
    cleanup: async () => {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('health and model routes return JSON responses', async () => {
  const harness = makeHarness();
  try {
    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
    assert.equal(health.json().ollama.version, 'mock');

    const models = await harness.app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(models.statusCode, 200);
    assert.equal(models.json().models[0].name, 'llama3.2:latest');
  } finally {
    await harness.cleanup();
  }
});

test('unload models route delegates to Ollama unload', async () => {
  let unloadCalled = false;
  const harness = makeHarness({}, {
    async unloadLoadedModels() {
      unloadCalled = true;
      return {
        unloaded: ['llama3.2:latest'],
        count: 1
      };
    }
  });

  try {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/models/unload'
    });

    assert.equal(response.statusCode, 200);
    assert.equal(unloadCalled, true);
    assert.deepEqual(response.json(), {
      unloaded: ['llama3.2:latest'],
      count: 1
    });
  } finally {
    await harness.cleanup();
  }
});

test('stats route returns backend resource usage', async () => {
  const harness = makeHarness();
  try {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/stats?model=llama3.2%3Alatest'
    });

    assert.equal(response.statusCode, 200);
    const stats = response.json();
    assert.equal(stats.backend.label, 'Ollama');
    assert.equal(typeof stats.cpu.usagePercent, 'number');
    assert.equal(typeof stats.ram.rssBytes, 'number');
    assert.ok('usagePercent' in stats.gpu);
  } finally {
    await harness.cleanup();
  }
});

test('chat routes create, list, and load chats', async () => {
  const harness = makeHarness();
  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        title: 'Local model notes',
        model: 'llama3.2:latest',
        systemPrompt: 'Answer concisely.'
      }
    });
    assert.equal(create.statusCode, 201);
    const chat = create.json().chat;

    const list = await harness.app.inject({ method: 'GET', url: '/api/chats' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().chats.length, 1);

    const load = await harness.app.inject({ method: 'GET', url: `/api/chats/${chat.id}` });
    assert.equal(load.statusCode, 200);
    assert.equal(load.json().chat.systemPrompt, 'Answer concisely.');
    assert.deepEqual(load.json().messages, []);
  } finally {
    await harness.cleanup();
  }
});

test('chat route applies the default naow prompt when no prompt is provided', async () => {
  const harness = makeHarness();
  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        title: 'Prompt default',
        model: 'llama3.2:latest'
      }
    });
    assert.equal(create.statusCode, 201);
    assert.match(create.json().chat.systemPrompt, /You are naow/);
  } finally {
    await harness.cleanup();
  }
});

test('message route validates empty content and missing model before streaming', async () => {
  const harness = makeHarness();
  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {}
    });
    const chat = create.json().chat;

    const empty = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { content: '   ' }
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.code, 'empty_message');

    const missingModel = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { content: 'Hello' }
    });
    assert.equal(missingModel.statusCode, 400);
    assert.equal(missingModel.json().error.code, 'missing_model');

    const load = await harness.app.inject({ method: 'GET', url: `/api/chats/${chat.id}` });
    assert.equal(load.json().messages.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('message route labels MLX stream errors distinctly', async () => {
  const harness = makeHarness({}, {
    async *streamChat() {
      throw new MlxStreamError('MLX native runtime failed');
    }
  });
  try {
    const chat = harness.db.createChat({ model: 'mlx-community/Qwen3.5-9B-MLX-4bit' });
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'Hello'
      }
    });

    const events = parseSse(response.payload);
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.error.code, 'mlx_stream_failed');
  } finally {
    await harness.cleanup();
  }
});

test('unknown chat returns 404', async () => {
  const harness = makeHarness();
  try {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/chats/not-real'
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'not_found');
  } finally {
    await harness.cleanup();
  }
});

test('serves built frontend and keeps unknown API routes as JSON errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naow-frontend-'));
  const frontendDist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(frontendDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(frontendDist, 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(frontendDist, 'assets', 'app.js'), 'console.log("naow");');

  const harness = makeHarness({
    NAOW_FRONTEND_DIST: frontendDist
  });

  try {
    const index = await harness.app.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /root/);

    const asset = await harness.app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'], /text\/javascript/);
    assert.match(asset.body, /naow/);

    const deepLink = await harness.app.inject({ method: 'GET', url: '/threads/example' });
    assert.equal(deepLink.statusCode, 200);
    assert.match(deepLink.body, /root/);

    const unknownApi = await harness.app.inject({ method: 'GET', url: '/api/not-real' });
    assert.equal(unknownApi.statusCode, 404);
    assert.equal(unknownApi.json().error.code, 'not_found');
  } finally {
    await harness.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('message route forwards generation options to Ollama', async () => {
  let receivedOptions;
  const harness = makeHarness({}, {
    async *streamChat({ options }) {
      receivedOptions = options;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'Use smaller context',
        options: {
          num_ctx: 32768
        }
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(receivedOptions, {
      num_ctx: 32768
    });
  } finally {
    await harness.cleanup();
  }
});

test('message route forwards prompt cache metadata and persists runner timings', async () => {
  let receivedCache;
  const harness = makeHarness({}, {
    backendForModel() {
      return { id: 'mlx', label: 'MLX' };
    },
    async *streamChat({ cache }) {
      receivedCache = cache;
      yield {
        type: 'meta',
        chatTemplateMs: 12,
        promptChars: 456,
        promptTokens: 78,
        promptCache: {
          enabled: true,
          hit: true,
          reusedTokens: 42,
          newTokens: 11
        }
      };
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'mlx-community/Qwen3.5-9B-MLX-4bit'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'hello',
        webSearch: false
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedCache.usePromptCache, true);
    assert.equal(receivedCache.chatId, chat.id);
    assert.equal(receivedCache.cacheBranchId, 'main');
    assert.equal(typeof receivedCache.systemPromptHash, 'string');
    const complete = parseSse(response.payload).at(-1).data.message;
    assert.equal(complete.metrics.promptBuildMs, 12);
    assert.equal(complete.metrics.promptChars, 456);
    assert.equal(complete.metrics.promptTokens, 78);
    assert.equal(complete.metrics.promptCacheHit, true);
    assert.equal(complete.metrics.promptCacheReusedTokens, 42);
    assert.equal(complete.metrics.promptCacheNewTokens, 11);
    assert.equal(complete.metrics.searchMode, 'none');
  } finally {
    await harness.cleanup();
  }
});

test('message route adds web search context when enabled and available', async () => {
  let receivedQuery;
  let receivedMaxResults;
  let receivedMessages;
  const searchClient = {
    async search(query, { maxResults }) {
      receivedQuery = query;
      receivedMaxResults = maxResults;
      return {
        provider: 'searxng',
        resultCount: 1,
        fetchedCount: 1,
        results: [
          {
            title: 'Example result',
            url: 'https://example.com/result',
            content: 'Useful current context.'
          }
        ]
      };
    }
  };
  const harness = makeHarness({ NAOW_SEARCH_MAX_RESULTS: '2' }, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient);

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'What changed today?'
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedQuery, 'What changed today?');
    assert.equal(receivedMaxResults, 2);
    assert.equal(receivedMessages[0].role, 'system');
    assert.match(receivedMessages[0].content, /Web search results/);
    assert.match(receivedMessages[0].content, /https:\/\/example\.com\/result/);

    const events = parseSse(response.payload);
    const complete = events.at(-1).data.message;
    assert.equal(complete.metrics.webSearch.provider, 'searxng');
    assert.equal(complete.metrics.webSearch.resultCount, 1);
    assert.equal(complete.metrics.sources[0].url, 'https://example.com/result');
    const searchEvent = events.find((event) => event.event === 'web_search');
    assert.equal(searchEvent, undefined);
    assert.equal(complete.metrics.toolCards.some((card) => card.name === 'web_search'), false);
    assert.equal(typeof complete.metrics.generationMs, 'number');
  } finally {
    await harness.cleanup();
  }
});

test('message route in normal search mode skips search when classifier says it is not needed', async () => {
  let normalSearchCalled = false;
  let receivedMessages;
  const searchClient = {
    async search() {
      normalSearchCalled = true;
      return { provider: 'searxng', results: [] };
    }
  };
  const preSearchManager = {
    async classifySubmitted(query) {
      assert.equal(query, 'Tell me a short joke');
      return { shouldSearch: false, confidence: 0.93, queries: [] };
    }
  };
  const harness = makeHarness({}, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient, { preSearchManager });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'Tell me a short joke',
        searchStrategy: 'normal'
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(normalSearchCalled, false);
    assert.equal(receivedMessages.some((message) => /Web search results/.test(message.content || '')), false);
    const events = parseSse(response.payload);
    const complete = events.at(-1).data.message;
    assert.equal(complete.metrics.webSearch.used, false);
    assert.equal(complete.metrics.webSearch.skipped, 'not_needed');
    assert.equal(complete.metrics.webSearch.classified, true);
  } finally {
    await harness.cleanup();
  }
});

test('message route in normal search mode searches when classifier requests it', async () => {
  let receivedQuery;
  const searchClient = {
    async search(query) {
      receivedQuery = query;
      return {
        provider: 'searxng',
        resultCount: 1,
        results: [{
          title: 'Current result',
          url: 'https://example.com/current',
          content: 'Fresh context.'
        }]
      };
    }
  };
  const preSearchManager = {
    async classifySubmitted(query) {
      assert.equal(query, 'What is new in Qwen today?');
      return { shouldSearch: true, confidence: 0.91, queries: ['Qwen news today'] };
    }
  };
  const harness = makeHarness({}, {
    async *streamChat() {
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient, { preSearchManager });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'What is new in Qwen today?',
        searchStrategy: 'normal'
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedQuery, 'Qwen news today');
    const events = parseSse(response.payload);
    const complete = events.at(-1).data.message;
    assert.equal(complete.metrics.webSearch.used, true);
    assert.equal(complete.metrics.webSearch.classified, true);
    assert.equal(complete.metrics.webSearch.searchStrategy, 'normal');
    assert.equal(complete.metrics.sources[0].url, 'https://example.com/current');
  } finally {
    await harness.cleanup();
  }
});

test('message route consumes matching pre-search results without emitting search cards', async () => {
  let normalSearchCalled = false;
  let receivedMessages;
  const searchClient = {
    async search() {
      normalSearchCalled = true;
      return { provider: 'searxng', results: [] };
    }
  };
  const preSearchManager = {
    consume({ preSearchId, finalQuery }) {
      assert.equal(preSearchId, 'pre_ready');
      assert.equal(finalQuery, 'What are the latest MLX releases today?');
      return {
        result: {
          provider: 'searxng',
          results: [{
            title: 'Pre result',
            url: 'https://example.com/pre',
            content: 'Warmed context.'
          }],
          fetchedCount: 0,
          elapsedMs: 0,
          draftFinalSimilarity: 1
        }
      };
    }
  };
  const harness = makeHarness({}, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient, { preSearchManager });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'What are the latest MLX releases today?',
        preSearchId: 'pre_ready'
      }
    });

    const events = parseSse(response.payload);
    const complete = events.at(-1).data.message;
    assert.equal(response.statusCode, 200);
    assert.equal(normalSearchCalled, false);
    assert.match(receivedMessages[0].content, /https:\/\/example\.com\/pre/);
    assert.equal(events.find((event) => event.event === 'web_search'), undefined);
    assert.equal(complete.metrics.webSearch.fromPreSearch, true);
    assert.equal(complete.metrics.sources[0].url, 'https://example.com/pre');
    assert.equal(complete.metrics.toolCards.some((card) => card.name === 'web_search'), false);
  } finally {
    await harness.cleanup();
  }
});

test('edit message route replaces the edited user turn and following context', async () => {
  let receivedMessages;
  const harness = makeHarness({}, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'edited answer' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;
    const oldUser = harness.db.createUserMessage(chat.id, 'old question');
    const oldAssistant = harness.db.createAssistantMessage(chat.id, 'old_generation');
    harness.db.finalizeMessage(oldAssistant.id, {
      content: 'old answer',
      status: 'complete'
    });
    harness.db.createUserMessage(chat.id, 'context that should be removed');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages/${oldUser.id}/edit`,
      payload: {
        content: 'edited question',
        model: 'llama3.2:latest',
        webSearch: false
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedMessages.some((message) => message.content === 'old answer'), false);
    assert.equal(receivedMessages.at(-1).content, 'edited question');
    const visible = harness.db.getMessages(chat.id);
    assert.deepEqual(visible.map((message) => message.content), ['edited question', 'edited answer']);
    const replaced = harness.db.getMessages(chat.id, { includeReplaced: true }).filter((message) => message.status === 'replaced');
    assert.equal(replaced.length, 3);
  } finally {
    await harness.cleanup();
  }
});

test('weather fast path emits display data and persists a tool card', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('https://geo.test')) {
      return Response.json({
        results: [{
          name: 'San Francisco',
          admin1: 'California',
          country: 'United States',
          latitude: 37.77,
          longitude: -122.42,
          timezone: 'America/Los_Angeles'
        }]
      });
    }
    return Response.json({
      timezone: 'America/Los_Angeles',
      current: {
        time: '2026-04-18T12:00',
        temperature_2m: 65,
        apparent_temperature: 64,
        relative_humidity_2m: 55,
        precipitation: 0,
        weather_code: 0,
        wind_speed_10m: 8,
        wind_gusts_10m: 12
      },
      daily: {
        time: ['2026-04-18', '2026-04-19'],
        weather_code: [0, 2],
        temperature_2m_max: [68, 66],
        temperature_2m_min: [52, 51],
        precipitation_probability_max: [5, 10],
        precipitation_sum: [0, 0],
        wind_speed_10m_max: [13, 14]
      }
    });
  };

  const harness = makeHarness({
    NAOW_WEATHER_GEOCODE_URL: 'https://geo.test/search',
    NAOW_WEATHER_FORECAST_URL: 'https://forecast.test/forecast'
  }, {
    async *streamChat() {
      yield { type: 'token', delta: 'unused' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'weather in San Francisco',
        webSearch: false
      }
    });

    const events = parseSse(response.payload);
    const result = events.find((event) => event.event === 'tool_call_result');
    assert.equal(result.data.name, 'get_weather');
    assert.equal(result.data.display.title, 'San Francisco, California, United States');
    assert.match(result.data.display.summary, /65F/);

    const complete = events.at(-1).data.message;
    assert.equal(complete.metrics.toolCards[0].name, 'get_weather');
    assert.equal(complete.metrics.toolCards[0].display.rows.some((row) => row.label === 'Humidity'), true);

    const load = await harness.app.inject({ method: 'GET', url: `/api/chats/${chat.id}` });
    const assistant = load.json().messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.metrics.toolCards[0].display.title, 'San Francisco, California, United States');
  } finally {
    await harness.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('tool errors emit error cards without blocking message completion', async () => {
  const harness = makeHarness({}, {
    async completeChat() {
      return {
        message: {
          content: '',
          tool_calls: [{
            id: 'bad_calc',
            function: {
              name: 'calculate',
              arguments: JSON.stringify({ expression: '1 / 0' })
            }
          }]
        }
      };
    },
    async *streamChat() {
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'please calculate something tricky',
        webSearch: false
      }
    });

    const events = parseSse(response.payload);
    const error = events.find((event) => event.event === 'tool_call_error');
    assert.equal(error.data.toolCallId, 'bad_calc');
    assert.equal(error.data.display.summary, 'Division by zero.');
    assert.equal(events.at(-1).event, 'message_complete');
    assert.equal(events.at(-1).data.message.metrics.toolCards[0].status, 'error');
  } finally {
    await harness.cleanup();
  }
});

test('timer tool cards preserve legacy tool actions', async () => {
  const harness = makeHarness({}, {
    async *streamChat() {
      yield { type: 'token', delta: 'unused' };
      yield { type: 'done', doneReason: 'stop' };
    }
  });

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'set a timer for 2 seconds',
        webSearch: false
      }
    });

    const events = parseSse(response.payload);
    const complete = events.at(-1).data.message;
    assert.equal(complete.metrics.toolActions[0].action.action, 'timer_start');
    assert.equal(complete.metrics.toolCards[0].action, 'timer_start');
    assert.equal(complete.metrics.toolCards[0].display.title, 'Timer');
  } finally {
    await harness.cleanup();
  }
});

test('message route skips web search context when disabled', async () => {
  let searchCalled = false;
  let receivedMessages;
  const searchClient = {
    async search() {
      searchCalled = true;
      return { provider: 'searxng', results: [] };
    }
  };
  const harness = makeHarness({}, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient);

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'What changed today?',
        webSearch: false
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(searchCalled, false);
    assert.equal(receivedMessages.some((message) => /Web search results/.test(message.content)), false);
  } finally {
    await harness.cleanup();
  }
});

test('message route emits skipped web search event and still streams', async () => {
  let receivedMessages;
  const searchClient = {
    async search() {
      return {
        provider: 'searxng',
        results: [],
        skipped: 'provider_unavailable',
        message: 'Local search is not available.'
      };
    }
  };
  const harness = makeHarness({}, {
    async *streamChat({ messages }) {
      receivedMessages = messages;
      yield { type: 'token', delta: 'ok' };
      yield { type: 'done', doneReason: 'stop' };
    }
  }, searchClient);

  try {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: {
        model: 'llama3.2:latest'
      }
    });
    const chat = create.json().chat;

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'What changed today?'
      }
    });
    const events = parseSse(response.payload);

    assert.equal(response.statusCode, 200);
    assert.equal(events.find((event) => event.event === 'web_search'), undefined);
    assert.equal(events.at(-1).event, 'message_complete');
    assert.equal(events.at(-1).data.message.content, 'ok');
    assert.equal(receivedMessages.some((message) => /Web search results/.test(message.content)), false);
  } finally {
    await harness.cleanup();
  }
});
