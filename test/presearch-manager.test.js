import assert from 'node:assert/strict';
import test from 'node:test';
import { PreSearchManager } from '../src/presearch-manager.js';

function makeManager(modelClient = null) {
  return new PreSearchManager({
    config: {
      preSearchModel: 'mlx-community/Qwen3-0.6B-4bit-DWQ-053125',
      preSearchMaxDraftChars: 1200,
      preSearchMaxQueries: 5,
      preSearchMinTokens: 5,
      preSearchCacheMs: 60_000,
      preSearchMaxEntries: 10,
      preSearchMinConfidence: 0.65,
      searchMaxResults: 5,
      webSearchMaxResults: 5,
      preSearchMaxResults: 10
    },
    searchClient: {
      async search() {
        return { provider: 'test', results: [] };
      }
    },
    modelClient
  });
}

test('submitted search classifier skips ordinary comparison prompts without model latency', async () => {
  let modelCalled = false;
  const manager = makeManager({
    async completeChat() {
      modelCalled = true;
      return { message: { content: '{"shouldSearch":true,"confidence":1,"queries":["maps"]}' } };
    }
  });

  const result = await manager.classifySubmitted('explain the differences between apple maps and google maps');

  assert.equal(modelCalled, false);
  assert.equal(result.shouldSearch, false);
  assert.equal(result.skipped, 'general_comparison');
});

test('submitted search classifier skips non-searchy prompts before calling 0.6B', async () => {
  let modelCalled = false;
  const manager = makeManager({
    async completeChat() {
      modelCalled = true;
      return { message: { content: '{"shouldSearch":true,"confidence":1,"queries":["joke"]}' } };
    }
  });

  const result = await manager.classifySubmitted('tell me a short joke');

  assert.equal(modelCalled, false);
  assert.equal(result.shouldSearch, false);
  assert.equal(result.skipped, 'heuristic_not_needed');
});

test('submitted search classifier uses compact 0.6B calls for search-worthy prompts', async () => {
  let receivedOptions = null;
  const manager = makeManager({
    async completeChat({ options }) {
      receivedOptions = options;
      return { message: { content: '{"shouldSearch":true,"confidence":0.94,"queries":["qwen latest release"]}' } };
    }
  });

  const result = await manager.classifySubmitted('what is the latest qwen release today?');

  assert.equal(result.shouldSearch, true);
  assert.deepEqual(result.queries, ['qwen latest release']);
  assert.equal(receivedOptions.max_tokens, 64);
});
