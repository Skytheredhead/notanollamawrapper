import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDatabase } from '../src/db.js';
import { GenerationManager } from '../src/generation-manager.js';

function makeHarness(env = {}) {
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
    }
  };
  const app = buildApp({
    config,
    db,
    ollama,
    generationManager: new GenerationManager()
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
