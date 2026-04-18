import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDatabase } from '../src/db.js';
import { GenerationManager } from '../src/generation-manager.js';
import { OllamaClient } from '../src/ollama.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

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

async function readUntil(reader, predicate) {
  const decoder = new TextDecoder();
  let text = '';
  while (!predicate(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function createOllamaMock({ mode = 'complete' } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          {
            name: 'llama3.2:latest',
            modified_at: '2026-04-17T12:00:00.000Z',
            size: 123,
            digest: 'abc',
            details: {
              family: 'llama',
              parameter_size: '3B',
              quantization_level: 'Q4'
            }
          }
        ]
      }));
      return;
    }

    if (request.url === '/api/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: 'mock' }));
      return;
    }

    if (request.url === '/api/chat') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

      if (mode === 'error') {
        response.write(`${JSON.stringify({ message: { content: 'partial' }, done: false })}\n`);
        response.write(`${JSON.stringify({ error: 'mock stream failure' })}\n`);
        response.end();
        return;
      }

      if (mode === 'slow') {
        const tokens = ['one ', 'two ', 'three ', 'four '];
        let index = 0;
        const timer = setInterval(() => {
          if (response.destroyed || index >= tokens.length) {
            clearInterval(timer);
            if (!response.destroyed) {
              response.write(`${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
              response.end();
            }
            return;
          }
          response.write(`${JSON.stringify({ message: { content: tokens[index++] }, done: false })}\n`);
        }, 50);
        response.on('close', () => clearInterval(timer));
        return;
      }

      response.write(`${JSON.stringify({ message: { content: 'Hello ' }, done: false })}\n`);
      response.write(`${JSON.stringify({ message: { content: 'there.' }, done: false })}\n`);
      response.write(`${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return server;
}

async function createHarness({ mode = 'complete' } = {}) {
  const ollamaServer = createOllamaMock({ mode });
  const ollamaUrl = await listen(ollamaServer);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naow-stream-'));
  const config = loadConfig({
    NAOW_DB_PATH: path.join(dir, 'test.sqlite'),
    OLLAMA_BASE_URL: ollamaUrl
  }, dir);
  const db = new LocalDatabase(config.dbPath);
  const generationManager = new GenerationManager();
  const app = buildApp({
    config,
    db,
    ollama: new OllamaClient({
      baseUrl: config.ollamaBaseUrl,
      timeoutMs: config.ollamaTimeoutMs
    }),
    generationManager
  });

  return {
    app,
    db,
    config,
    generationManager,
    cleanup: async () => {
      await app.close();
      db.close();
      await closeServer(ollamaServer);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('models route normalizes Ollama tags', async () => {
  const harness = await createHarness();
  try {
    const response = await harness.app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().models[0], {
      name: 'llama3.2:latest',
      modifiedAt: '2026-04-17T12:00:00.000Z',
      size: 123,
      digest: 'abc',
      details: {
        family: 'llama',
        parameterSize: '3B',
        quantizationLevel: 'Q4'
      }
    });
  } finally {
    await harness.cleanup();
  }
});

test('message stream emits normalized events and persists final assistant content', async () => {
  const harness = await createHarness();
  try {
    const chat = harness.db.createChat({ model: 'llama3.2:latest' });
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'Say hello',
        webSearch: false
      }
    });

    assert.equal(response.statusCode, 200);
    const events = parseSse(response.payload);
    assert.deepEqual(events.map((event) => event.event), [
      'generation_start',
      'token',
      'token',
      'message_complete'
    ]);
    assert.equal(events[1].data.delta, 'Hello ');
    assert.equal(events[3].data.message.content, 'Hello there.');
    assert.equal(typeof events[3].data.message.metrics.generationMs, 'number');
    assert.equal(events[3].data.message.metrics.webSearchMs, 0);
    assert.equal(events[3].data.message.metrics.tokenCount, 2);

    const messages = harness.db.getMessages(chat.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Hello there.');
    assert.equal(messages[1].metrics.tokenCount, 2);
  } finally {
    await harness.cleanup();
  }
});

test('regenerate marks latest assistant as replaced and streams a new answer', async () => {
  const harness = await createHarness();
  try {
    const chat = harness.db.createChat({ model: 'llama3.2:latest' });
    harness.db.createUserMessage(chat.id, 'Say hello');
    const oldAssistant = harness.db.createAssistantMessage(chat.id, 'gen_old');
    harness.db.finalizeMessage(oldAssistant.id, {
      content: 'Old answer',
      status: 'complete'
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/regenerate`,
      payload: {}
    });
    assert.equal(response.statusCode, 200);
    const events = parseSse(response.payload);
    assert.equal(events.at(-1).event, 'message_complete');

    const allMessages = harness.db.getMessages(chat.id, { includeReplaced: true });
    assert.equal(allMessages.length, 3);
    assert.equal(allMessages[1].status, 'replaced');
    assert.equal(allMessages[2].content, 'Hello there.');
  } finally {
    await harness.cleanup();
  }
});

test('ollama stream errors emit error event and persist error status', async () => {
  const harness = await createHarness({ mode: 'error' });
  try {
    const chat = harness.db.createChat({ model: 'llama3.2:latest' });
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: {
        content: 'Break'
      }
    });

    const events = parseSse(response.payload);
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.error.code, 'ollama_stream_failed');

    const messages = harness.db.getMessages(chat.id);
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'partial');
  } finally {
    await harness.cleanup();
  }
});

test('stop endpoint cancels a slow generation and persists partial content', async () => {
  const harness = await createHarness({ mode: 'slow' });
  let backendUrl;
  try {
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    backendUrl = `http://127.0.0.1:${address.port}`;

    const chat = harness.db.createChat({ model: 'llama3.2:latest' });
    const streamResponse = await fetch(`${backendUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'Count' })
    });
    assert.equal(streamResponse.status, 200);

    const reader = streamResponse.body.getReader();
    let text = await readUntil(reader, (value) => value.includes('event: token'));

    const conflict = await fetch(`${backendUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'Concurrent' })
    });
    assert.equal(conflict.status, 409);

    const stop = await fetch(`${backendUrl}/api/chats/${chat.id}/stop`, {
      method: 'POST'
    });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).stopped, true);

    text += await readUntil(reader, (value) => value.includes('event: cancelled'));
    const events = parseSse(text);
    assert.equal(events.at(-1).event, 'cancelled');
    assert.equal(events.at(-1).data.reason, 'user_stopped');

    const messages = harness.db.getMessages(chat.id);
    assert.equal(messages[1].status, 'cancelled');
    assert.match(messages[1].content, /^one /);
  } finally {
    await harness.cleanup();
  }
});
