import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDatabase } from '../src/db.js';
import { GenerationManager } from '../src/generation-manager.js';
import { IdleResourceGuard } from '../src/idle-resource-guard.js';

function makeConfig(dir) {
  return {
    idleCleanupEnabled: true,
    idleCleanupDelayMs: 1000,
    idleCleanupIntervalMs: 1000,
    idleUnloadModels: true,
    idleUnloadPinnedMlx: true,
    idleSearchStopMs: 2000,
    idleAttachmentTtlMs: 1,
    idleCacheMaxEntries: 3,
    attachmentsDir: path.join(dir, 'attachments')
  };
}

test('idle guard waits for inactivity before cleaning resources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naow-idle-'));
  const db = new LocalDatabase(path.join(dir, 'test.sqlite'));
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  const orphanPath = path.join(dir, 'attachments', 'orphan.png');
  fs.writeFileSync(orphanPath, 'old');
  fs.utimesSync(orphanPath, new Date(0), new Date(0));

  let now = 0;
  let unloadCalls = 0;
  let searchStopRequested = false;
  const generationManager = new GenerationManager({ now: () => now });
  const guard = new IdleResourceGuard({
    config: makeConfig(dir),
    generationManager,
    modelClient: {
      async unloadLoadedModels(options) {
        unloadCalls += 1;
        assert.equal(options.includePinnedMlx, true);
        return { unloaded: ['model'], count: 1 };
      }
    },
    searchClient: {
      async cleanupIdle(options) {
        searchStopRequested = Boolean(options.stopSidecar);
        return { queryCache: { size: 0 }, pageCache: { size: 0 } };
      }
    },
    db,
    logger: { warn() {} },
    now: () => now
  });

  try {
    assert.equal((await guard.runOnce()).skipped, 'active');
    assert.equal(unloadCalls, 0);
    assert.equal(fs.existsSync(orphanPath), true);

    now = 1500;
    const cleaned = await guard.runOnce();
    assert.equal(cleaned.models.count, 1);
    assert.equal(cleaned.storage.deletedAttachments, 1);
    assert.equal(unloadCalls, 1);
    assert.equal(searchStopRequested, false);
    assert.equal(fs.existsSync(orphanPath), false);

    now = 3500;
    await guard.runOnce();
    assert.equal(searchStopRequested, true);
    assert.equal(unloadCalls, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idle guard does not clean while a generation is active', async () => {
  let now = 0;
  const generationManager = new GenerationManager({ now: () => now });
  const entry = generationManager.start({ chatId: 'chat', assistantMessageId: 'message' });
  now = 5000;

  let unloadCalls = 0;
  const guard = new IdleResourceGuard({
    config: makeConfig(os.tmpdir()),
    generationManager,
    modelClient: {
      async unloadLoadedModels() {
        unloadCalls += 1;
      }
    },
    logger: { warn() {} },
    now: () => now
  });

  assert.equal((await guard.runOnce()).skipped, 'active');
  assert.equal(unloadCalls, 0);

  generationManager.finish(entry.generationId);
  assert.equal((await guard.runOnce()).skipped, 'active');
});
