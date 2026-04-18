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

function makeHarness(env = {}, ollamaOverrides = {}, searchClient = null) {
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
    searchClient
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
    assert.equal(typeof complete.metrics.generationMs, 'number');
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
    assert.equal(events.find((event) => event.event === 'web_search').data.used, false);
    assert.equal(events.at(-1).event, 'message_complete');
    assert.equal(events.at(-1).data.message.content, 'ok');
    assert.equal(receivedMessages.some((message) => /Web search results/.test(message.content)), false);
  } finally {
    await harness.cleanup();
  }
});
