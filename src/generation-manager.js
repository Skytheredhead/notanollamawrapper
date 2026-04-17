import { randomUUID } from 'node:crypto';

export class GenerationInProgressError extends Error {
  constructor(chatId) {
    super(`Chat ${chatId} already has an active generation.`);
    this.name = 'GenerationInProgressError';
    this.chatId = chatId;
  }
}

export class GenerationManager {
  constructor() {
    this.byGenerationId = new Map();
    this.byChatId = new Map();
  }

  start({ chatId, assistantMessageId }) {
    if (this.byChatId.has(chatId)) {
      throw new GenerationInProgressError(chatId);
    }

    const generationId = `gen_${randomUUID()}`;
    const abortController = new AbortController();
    const entry = {
      generationId,
      chatId,
      assistantMessageId,
      abortController,
      startedAt: new Date().toISOString(),
      stopReason: null
    };

    this.byGenerationId.set(generationId, entry);
    this.byChatId.set(chatId, generationId);
    return entry;
  }

  getByChat(chatId) {
    const generationId = this.byChatId.get(chatId);
    return generationId ? this.byGenerationId.get(generationId) || null : null;
  }

  getByGeneration(generationId) {
    return this.byGenerationId.get(generationId) || null;
  }

  stopByChat(chatId, reason = 'user_stopped') {
    const entry = this.getByChat(chatId);
    if (!entry) return null;
    this.stopEntry(entry, reason);
    return entry;
  }

  stopByGeneration(generationId, reason = 'user_stopped') {
    const entry = this.getByGeneration(generationId);
    if (!entry) return null;
    this.stopEntry(entry, reason);
    return entry;
  }

  stopEntry(entry, reason) {
    if (entry.abortController.signal.aborted) return;
    entry.stopReason = reason;
    entry.abortController.abort(reason);
  }

  finish(generationId) {
    const entry = this.byGenerationId.get(generationId);
    if (!entry) return;
    this.byGenerationId.delete(generationId);
    const activeForChat = this.byChatId.get(entry.chatId);
    if (activeForChat === generationId) {
      this.byChatId.delete(entry.chatId);
    }
  }

  stopAll(reason = 'server_shutdown') {
    const entries = Array.from(this.byGenerationId.values());
    for (const entry of entries) {
      this.stopEntry(entry, reason);
    }
    return entries;
  }
}
