import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizeDefaultSystemPrompt } from './default-system-prompt.js';

function rowToChat(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: normalizeDefaultSystemPrompt(row.system_prompt),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function metadataFromRow(row) {
  let metadata = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    metadata = {};
  }
  return metadata;
}

function truncateContextNote(value, maxChars = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 12)).trim()}...`;
}

function toolCardsContext(metadata = {}) {
  const cards = metadata.metrics?.toolCards || [];
  const lines = [];
  for (const card of cards.slice(-4)) {
    const name = card.name || card.toolName;
    const display = card.display || {};
    if (name === 'calculate' && display.calculator) {
      const expression = display.calculator.expression || '';
      const result = display.calculator.result ?? '';
      if (result !== '') lines.push(`calculator result: ${expression ? `${expression} = ` : ''}${result}`);
      continue;
    }
    if (name === 'get_weather') {
      const title = display.title || 'weather';
      const summary = display.summary || '';
      const rows = Array.isArray(display.rows)
        ? display.rows.slice(0, 4).map((row) => `${row.label}: ${row.value}`).join('; ')
        : '';
      lines.push(`weather result: ${[title, summary, rows].filter(Boolean).join(' - ')}`);
      continue;
    }
    if (name && display.summary) {
      lines.push(`${name} result: ${display.summary}`);
    }
  }
  if (!lines.length) return '';
  return `[Internal tool context for follow-ups: ${truncateContextNote(lines.join('; '))}]`;
}

function rowToMessage(row) {
  if (!row) return null;
  const metadata = metadataFromRow(row);
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    status: row.status,
    generationId: row.generation_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    metadata,
    metrics: metadata.metrics || null
  };
}

function rowToAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    messageId: row.message_id,
    chatId: row.chat_id,
    type: row.type,
    mimeType: row.mime_type,
    name: row.original_name,
    path: row.path,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/attachments/${row.id}`
  };
}

function rowToChatSummary(row) {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview
      ? row.last_message_preview.slice(0, 160)
      : null
  };
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    updatedAt: row.updated_at ?? row.updatedAt,
    id: row.id
  })).toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed.updatedAt || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class LocalDatabase {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.lastTimestampMs = 0;
    this.db = new Database(dbPath);
    this.migrate();
    this.prepare();
  }

  now() {
    const current = Date.now();
    const next = current <= this.lastTimestampMs ? this.lastTimestampMs + 1 : current;
    this.lastTimestampMs = next;
    return new Date(next).toISOString();
  }

  migrate() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT,
        system_prompt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('complete', 'streaming', 'cancelled', 'error', 'replaced')
        ),
        generation_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('image')),
        mime_type TEXT NOT NULL,
        original_name TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chats_updated_at
        ON chats(updated_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
        ON messages(chat_id, created_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS idx_messages_generation
        ON messages(generation_id);

      CREATE INDEX IF NOT EXISTS idx_message_attachments_message
        ON message_attachments(message_id);
    `);

    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all();
    if (!messageColumns.some((column) => column.name === 'metadata_json')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN metadata_json TEXT');
    }
  }

  prepare() {
    this.statements = {
      health: this.db.prepare('SELECT 1 AS ok'),
      createChat: this.db.prepare(`
        INSERT INTO chats (id, title, model, system_prompt, created_at, updated_at)
        VALUES (@id, @title, @model, @systemPrompt, @createdAt, @updatedAt)
      `),
      getChat: this.db.prepare('SELECT * FROM chats WHERE id = ?'),
      touchChat: this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?'),
      setChatModelIfEmpty: this.db.prepare(`
        UPDATE chats SET model = ?, updated_at = ? WHERE id = ? AND model IS NULL
      `),
      listChats: this.db.prepare(`
        SELECT
          c.*,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.chat_id = c.id AND m.status != 'replaced'
          ) AS message_count,
          (
            SELECT m.content
            FROM messages m
            WHERE m.chat_id = c.id AND m.status != 'replaced'
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT 1
          ) AS last_message_preview
        FROM chats c
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?
      `),
      listChatsAfterCursor: this.db.prepare(`
        SELECT
          c.*,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.chat_id = c.id AND m.status != 'replaced'
          ) AS message_count,
          (
            SELECT m.content
            FROM messages m
            WHERE m.chat_id = c.id AND m.status != 'replaced'
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT 1
          ) AS last_message_preview
        FROM chats c
        WHERE (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?
      `),
      insertMessage: this.db.prepare(`
        INSERT INTO messages (
          id,
          chat_id,
          role,
          content,
          status,
          generation_id,
          error,
          created_at,
          updated_at,
          completed_at,
          metadata_json
        )
        VALUES (
          @id,
          @chatId,
          @role,
          @content,
          @status,
          @generationId,
          @error,
          @createdAt,
          @updatedAt,
          @completedAt,
          @metadataJson
        )
      `),
      getMessage: this.db.prepare('SELECT * FROM messages WHERE id = ?'),
      getMessagesVisible: this.db.prepare(`
        SELECT * FROM messages
        WHERE chat_id = ? AND status != 'replaced'
        ORDER BY created_at ASC, id ASC
      `),
      getMessagesAll: this.db.prepare(`
        SELECT * FROM messages
        WHERE chat_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      getVisibleContext: this.db.prepare(`
        SELECT id, role, content, metadata_json FROM messages
        WHERE chat_id = ?
          AND status IN ('complete', 'cancelled')
          AND content != ''
        ORDER BY created_at ASC, id ASC
      `),
      getVisibleContextBefore: this.db.prepare(`
        SELECT id, role, content, metadata_json FROM messages
        WHERE chat_id = ?
          AND status IN ('complete', 'cancelled')
          AND content != ''
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at ASC, id ASC
      `),
      getLatestVisibleAssistant: this.db.prepare(`
        SELECT * FROM messages
        WHERE chat_id = ?
          AND role = 'assistant'
          AND status != 'replaced'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      finalizeMessage: this.db.prepare(`
        UPDATE messages
        SET content = ?, status = ?, error = ?, updated_at = ?, completed_at = ?, metadata_json = ?
        WHERE id = ?
      `),
      markMessageReplaced: this.db.prepare(`
        UPDATE messages
        SET status = 'replaced', updated_at = ?
        WHERE id = ?
      `),
      insertAttachment: this.db.prepare(`
        INSERT INTO message_attachments (
          id,
          message_id,
          chat_id,
          type,
          mime_type,
          original_name,
          path,
          size_bytes,
          created_at
        )
        VALUES (
          @id,
          @messageId,
          @chatId,
          @type,
          @mimeType,
          @originalName,
          @path,
          @sizeBytes,
          @createdAt
        )
      `),
      getAttachment: this.db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
      listAttachmentPaths: this.db.prepare('SELECT path FROM message_attachments'),
      getAttachmentsForChat: this.db.prepare(`
        SELECT * FROM message_attachments
        WHERE chat_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      getContextAttachments: this.db.prepare(`
        SELECT * FROM message_attachments
        WHERE message_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      updateChatTitle: this.db.prepare(`
        UPDATE chats SET title = @title, updated_at = @updatedAt WHERE id = @id
      `)
    };
  }

  close() {
    this.db.close();
  }

  checkpoint() {
    this.db.pragma('wal_checkpoint(PASSIVE)');
    this.db.pragma('optimize');
  }

  isHealthy() {
    return this.statements.health.get()?.ok === 1;
  }

  createChat({ title = 'New chat', model = null, systemPrompt = null } = {}) {
    const timestamp = this.now();
    const chat = {
      id: randomUUID(),
      title: title || 'New chat',
      model: model || null,
      systemPrompt: systemPrompt || null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.statements.createChat.run(chat);
    return chat;
  }

  getChat(chatId) {
    return rowToChat(this.statements.getChat.get(chatId));
  }

  touchChat(chatId, timestamp = this.now()) {
    this.statements.touchChat.run(timestamp, chatId);
  }

  setChatModelIfEmpty(chatId, model) {
    if (!model) return;
    this.statements.setChatModelIfEmpty.run(model, this.now(), chatId);
  }

  updateChatTitle(chatId, title) {
    const value = String(title || '').trim();
    if (!value) return false;
    const result = this.statements.updateChatTitle.run({
      id: chatId,
      title: value.slice(0, 200),
      updatedAt: this.now()
    });
    return result.changes > 0;
  }

  listChats({ limit = 50, cursor = null } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
    const queryLimit = safeLimit + 1;
    const decoded = decodeCursor(cursor);
    const rows = decoded
      ? this.statements.listChatsAfterCursor.all(
        decoded.updatedAt,
        decoded.updatedAt,
        decoded.id,
        queryLimit
      )
      : this.statements.listChats.all(queryLimit);

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

    return {
      chats: pageRows.map(rowToChatSummary),
      nextCursor: hasMore ? encodeCursor(pageRows.at(-1)) : null
    };
  }

  getMessages(chatId, { includeReplaced = false } = {}) {
    const rows = includeReplaced
      ? this.statements.getMessagesAll.all(chatId)
      : this.statements.getMessagesVisible.all(chatId);
    const messages = rows.map(rowToMessage);
    const attachments = this.statements.getAttachmentsForChat.all(chatId).map(rowToAttachment);
    const byMessage = new Map();
    for (const attachment of attachments) {
      if (!byMessage.has(attachment.messageId)) byMessage.set(attachment.messageId, []);
      byMessage.get(attachment.messageId).push(attachment);
    }
    return messages.map((message) => ({
      ...message,
      attachments: byMessage.get(message.id) || []
    }));
  }

  getVisibleContext(chat, beforeMessage = null) {
    const rows = beforeMessage
      ? this.statements.getVisibleContextBefore.all(
        chat.id,
        beforeMessage.createdAt,
        beforeMessage.createdAt,
        beforeMessage.id
      )
      : this.statements.getVisibleContext.all(chat.id);

    const messages = rows.map((row) => ({
      role: row.role,
      content: [
        row.content,
        row.role === 'assistant' ? toolCardsContext(metadataFromRow(row)) : ''
      ].filter(Boolean).join('\n\n'),
      attachments: this.statements.getContextAttachments.all(row.id).map(rowToAttachment)
    }));

    if (chat.systemPrompt) {
      messages.unshift({
        role: 'system',
        content: chat.systemPrompt
      });
    }

    return messages;
  }

  createUserMessage(chatId, content) {
    const timestamp = this.now();
    const message = {
      id: randomUUID(),
      chatId,
      role: 'user',
      content,
      status: 'complete',
      generationId: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      metadataJson: null
    };

    const transaction = this.db.transaction(() => {
      this.statements.insertMessage.run(message);
      this.touchChat(chatId, timestamp);
    });
    transaction();
    return message;
  }

  createUserMessageWithAttachments(chatId, content, attachments = []) {
    const message = this.createUserMessage(chatId, content);
    for (const attachment of attachments) {
      this.createAttachment({
        ...attachment,
        chatId,
        messageId: message.id
      });
    }
    return {
      ...message,
      attachments: this.statements.getContextAttachments.all(message.id).map(rowToAttachment)
    };
  }

  createAttachment({ chatId, messageId, type = 'image', mimeType, originalName, path: filePath, sizeBytes }) {
    const attachment = {
      id: randomUUID(),
      messageId,
      chatId,
      type,
      mimeType,
      originalName,
      path: filePath,
      sizeBytes,
      createdAt: this.now()
    };
    this.statements.insertAttachment.run(attachment);
    return {
      ...attachment,
      name: originalName,
      url: `/api/attachments/${attachment.id}`
    };
  }

  getAttachment(attachmentId) {
    return rowToAttachment(this.statements.getAttachment.get(attachmentId));
  }

  listAttachmentPaths() {
    return this.statements.listAttachmentPaths.all().map((row) => row.path).filter(Boolean);
  }

  createAssistantMessage(chatId, generationId) {
    const timestamp = this.now();
    const message = {
      id: randomUUID(),
      chatId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      generationId,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      metadataJson: null
    };

    this.statements.insertMessage.run(message);
    return message;
  }

  getMessage(messageId) {
    return rowToMessage(this.statements.getMessage.get(messageId));
  }

  finalizeMessage(messageId, { content, status, error = null, metadata = null } = {}) {
    const timestamp = this.now();
    this.statements.finalizeMessage.run(
      content,
      status,
      error,
      timestamp,
      timestamp,
      metadata ? JSON.stringify(metadata) : null,
      messageId
    );
    const message = this.getMessage(messageId);
    if (message) {
      this.touchChat(message.chatId, timestamp);
    }
    return message;
  }

  getLatestVisibleAssistant(chatId) {
    return rowToMessage(this.statements.getLatestVisibleAssistant.get(chatId));
  }

  markMessageReplaced(messageId) {
    this.statements.markMessageReplaced.run(this.now(), messageId);
    return this.getMessage(messageId);
  }
}
