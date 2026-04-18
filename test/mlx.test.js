import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridModelClient, MlxClient } from '../src/mlx.js';
import { OllamaStreamError } from '../src/ollama.js';

test('MLX client forwards image attachment paths to the runner', async () => {
  const requests = [];
  const client = new MlxClient({
    baseUrl: 'http://mlx.test',
    modelName: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/runtime/residency')) {
        return new Response(JSON.stringify({ residency: 'always_hot' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response([
        JSON.stringify({ type: 'meta', promptCache: { enabled: true, hit: true, reusedTokens: 12, newTokens: 3 } }),
        JSON.stringify({ type: 'token', delta: 'ok' }),
        JSON.stringify({ type: 'done', doneReason: 'stop' }),
        ''
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' }
      });
    }
  });

  const events = [];
  for await (const event of client.streamChat({
    model: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    messages: [
      {
        role: 'user',
        content: 'What is this?',
        attachments: [
          {
            type: 'image',
            path: '/tmp/pixel.png'
          }
        ]
      }
    ],
    options: { max_tokens: 4 },
    cache: {
      usePromptCache: true,
      chatId: 'chat_1',
      cacheBranchId: 'main',
      systemPromptHash: 'abc',
      attachmentSignature: 'image'
    }
  })) {
    events.push(event);
  }

  const chatRequest = requests.find((request) => request.url.endsWith('/chat/stream'));
  assert.ok(chatRequest);
  const payload = JSON.parse(chatRequest.options.body);
  assert.deepEqual(payload.images, ['/tmp/pixel.png']);
  assert.equal(payload.cache.chatId, 'chat_1');
  assert.deepEqual(events, [
    { type: 'meta', promptCache: { enabled: true, hit: true, reusedTokens: 12, newTokens: 3 } },
    { type: 'token', delta: 'ok' },
    { type: 'done', doneReason: 'stop' }
  ]);
});

test('MLX client treats Hugging Face model ids as MLX targets', () => {
  const client = new MlxClient({
    baseUrl: 'http://mlx.test',
    modelName: 'mlx-community/Qwen3.5-9B-MLX-4bit'
  });

  assert.equal(client.isMlxModel('mlx-community/Qwen3.5-9B-MLX-4bit'), true);
  assert.equal(client.isMlxModel('Jiunsong/supergemma4-26b-uncensored-mlx-4bit-v2'), true);
  assert.equal(client.isMlxModel('gemma4:e2b'), false);
});

test('hybrid client falls back to MLX when Ollama is unavailable before streaming', async () => {
  const calls = [];
  const hybrid = new HybridModelClient({
    ollama: {
      async *streamChat() {
        throw new OllamaStreamError('Could not reach Ollama at http://127.0.0.1:11434');
      }
    },
    mlx: {
      modelName: 'mlx-community/Qwen3.5-9B-MLX-4bit',
      isMlxModel(model) {
        return model === this.modelName;
      },
      async *streamChat(request) {
        calls.push(request);
        yield { type: 'token', delta: 'fallback' };
        yield { type: 'done', doneReason: 'stop' };
      }
    }
  });

  const events = [];
  for await (const event of hybrid.streamChat({
    model: 'gemma4:e2b',
    messages: [{ role: 'user', content: 'hello' }],
    options: { max_tokens: 8 }
  })) {
    events.push(event);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'mlx-community/Qwen3.5-9B-MLX-4bit');
  assert.equal(calls[0].options.fallbackFrom, 'gemma4:e2b');
  assert.deepEqual(events, [
    { type: 'token', delta: 'fallback' },
    { type: 'done', doneReason: 'stop' }
  ]);
});
