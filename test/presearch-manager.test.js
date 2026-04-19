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

test('submitted search classifier rewrites search-worthy prompts with 0.6B into real queries', async () => {
  let modelCalled = false;
  const manager = makeManager({
    async completeChat() {
      modelCalled = true;
      return { message: { content: '{"queries":["qwen latest release"]}' } };
    }
  });

  const draft = 'what is the latest qwen release today?';
  const result = await manager.classifySubmitted(draft);

  assert.equal(modelCalled, true);
  assert.equal(result.shouldSearch, true);
  assert.deepEqual(result.queries, ['qwen latest release']);
});

test('submitted search classifier treats explicit google requests as search', async () => {
  let modelCalled = false;
  const manager = makeManager({
    async completeChat() {
      modelCalled = true;
      return { message: { content: '{"shouldSearch":false,"confidence":1,"queries":[]}' } };
    }
  });

  const result = await manager.classifySubmitted('can you google please');

  assert.equal(modelCalled, false);
  assert.equal(result.shouldSearch, true);
  assert.equal(result.confidence, 1);
  assert.equal(result.explicitSearch, true);
});
