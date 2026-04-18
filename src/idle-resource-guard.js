import fs from 'node:fs';
import path from 'node:path';

function toSet(values = []) {
  return new Set(values.map((value) => path.resolve(String(value))).filter(Boolean));
}

function pruneOrphanAttachments({ attachmentsDir, referencedPaths, ttlMs, now }) {
  const deleted = [];
  if (!attachmentsDir || !fs.existsSync(attachmentsDir)) return deleted;

  const root = path.resolve(attachmentsDir);
  const referenced = toSet(referencedPaths);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(root, entry.name);
    const resolved = path.resolve(filePath);
    if (referenced.has(resolved)) continue;

    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (now - stats.mtimeMs < ttlMs) continue;

    fs.rmSync(resolved, { force: true });
    deleted.push(resolved);
  }
  return deleted;
}

export class IdleResourceGuard {
  constructor({
    config,
    generationManager,
    modelClient,
    searchClient = null,
    db = null,
    logger = console,
    now = () => Date.now()
  }) {
    this.config = config;
    this.generationManager = generationManager;
    this.modelClient = modelClient;
    this.searchClient = searchClient;
    this.db = db;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.lastModelUnloadAt = -1;
    this.lastSearchStopAt = -1;
  }

  start() {
    if (!this.config.idleCleanupEnabled || this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        this.logger.warn?.(`Idle cleanup failed: ${error.message}`);
      });
    }, this.config.idleCleanupIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  idleSince() {
    return this.generationManager?.lastActivityAt ?? this.now();
  }

  isIdle(now = this.now()) {
    if (this.generationManager?.hasActive?.()) return false;
    return now - this.idleSince() >= this.config.idleCleanupDelayMs;
  }

  async runOnce() {
    if (!this.config.idleCleanupEnabled) return { skipped: 'disabled' };
    if (this.running) return { skipped: 'already_running' };

    const now = this.now();
    const idleSince = this.idleSince();
    if (!this.isIdle(now)) {
      return {
        skipped: 'active',
        idleForMs: Math.max(0, now - idleSince)
      };
    }

    this.running = true;
    const result = {
      idleForMs: Math.max(0, now - idleSince),
      models: null,
      search: null,
      storage: null,
      memory: null
    };

    try {
      if (this.config.idleUnloadModels && this.modelClient?.unloadLoadedModels && this.lastModelUnloadAt < idleSince) {
        this.lastModelUnloadAt = now;
        try {
          result.models = await this.modelClient.unloadLoadedModels({
            includePinnedMlx: this.config.idleUnloadPinnedMlx,
            reason: 'idle'
          });
        } catch (error) {
          result.models = { error: error.message };
        }
      }

      if (this.searchClient?.cleanupIdle) {
        const stopSidecar = this.config.idleSearchStopMs > 0
          && now - idleSince >= this.config.idleSearchStopMs
          && this.lastSearchStopAt < idleSince;
        if (stopSidecar) this.lastSearchStopAt = now;
        result.search = await this.searchClient.cleanupIdle({
          maxEntries: this.config.idleCacheMaxEntries,
          stopSidecar
        });
      }

      if (this.db) {
        const deletedAttachments = pruneOrphanAttachments({
          attachmentsDir: this.config.attachmentsDir,
          referencedPaths: this.db.listAttachmentPaths?.() || [],
          ttlMs: this.config.idleAttachmentTtlMs,
          now
        });
        this.db.checkpoint?.();
        result.storage = {
          deletedAttachments: deletedAttachments.length
        };
      }

      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        result.memory = { gc: true };
      } else {
        result.memory = { gc: false };
      }

      return result;
    } finally {
      this.running = false;
    }
  }
}
