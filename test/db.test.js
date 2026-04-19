import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDatabase } from '../src/db.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naow-db-'));
  const db = new LocalDatabase(path.join(dir, 'test.sqlite'));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('database creates chats, stores messages, and lists summaries', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(db.isHealthy(), true);

    const chat = db.createChat({
      title: 'Local notes',
      model: 'llama3.2:latest',
      systemPrompt: 'Be brief.'
    });
    assert.equal(chat.title, 'Local notes');

    const user = db.createUserMessage(chat.id, 'Hello');
    const assistant = db.createAssistantMessage(chat.id, 'gen_test');
    const complete = db.finalizeMessage(assistant.id, {
      content: 'Hi there.',
      status: 'complete'
    });

    assert.equal(user.status, 'complete');
    assert.equal(complete.content, 'Hi there.');

    const page = db.listChats({ limit: 10 });
    assert.equal(page.chats.length, 1);
    assert.equal(page.chats[0].messageCount, 2);
    assert.equal(page.chats[0].lastMessagePreview, 'Hi there.');

    const messages = db.getMessages(chat.id);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  } finally {
    cleanup();
  }
});

test('database can update chat title', () => {
  const { db, cleanup } = tempDb();
  try {
    const chat = db.createChat({ title: 'New chat', model: 'm' });
    assert.equal(db.updateChatTitle(chat.id, 'Renamed topic'), true);
    assert.equal(db.getChat(chat.id).title, 'Renamed topic');
    assert.equal(db.updateChatTitle(chat.id, ''), false);
  } finally {
    cleanup();
  }
});

test('database excludes replaced messages by default and includes them when requested', () => {
  const { db, cleanup } = tempDb();
  try {
    const chat = db.createChat();
    db.createUserMessage(chat.id, 'Try again');
    const oldAssistant = db.createAssistantMessage(chat.id, 'gen_old');
    db.finalizeMessage(oldAssistant.id, {
      content: 'Old answer',
      status: 'complete'
    });
    db.markMessageReplaced(oldAssistant.id);
    const newAssistant = db.createAssistantMessage(chat.id, 'gen_new');
    db.finalizeMessage(newAssistant.id, {
      content: 'New answer',
      status: 'complete'
    });

    const visible = db.getMessages(chat.id);
    assert.equal(visible.length, 2);
    assert.equal(visible.at(-1).content, 'New answer');

    const all = db.getMessages(chat.id, { includeReplaced: true });
    assert.equal(all.length, 3);
    assert.equal(all[1].status, 'replaced');
  } finally {
    cleanup();
  }
});

test('visible context includes image attachments', () => {
  const { db, cleanup } = tempDb();
  try {
    const chat = db.createChat({ systemPrompt: 'Look carefully.' });
    db.createUserMessageWithAttachments(chat.id, 'Describe this', [
      {
        type: 'image',
        mimeType: 'image/png',
        originalName: 'pixel.png',
        path: '/tmp/pixel.png',
        sizeBytes: 68
      }
    ]);

    const context = db.getVisibleContext(db.getChat(chat.id));
    assert.equal(context.length, 2);
    assert.equal(context[0].role, 'system');
    assert.equal(context[1].attachments.length, 1);
    assert.equal(context[1].attachments[0].path, '/tmp/pixel.png');
  } finally {
    cleanup();
  }
});

test('visible context carries calculator tool results for follow-ups', () => {
  const { db, cleanup } = tempDb();
  try {
    const chat = db.createChat();
    db.createUserMessage(chat.id, '67*67');
    const assistant = db.createAssistantMessage(chat.id, 'gen_calc');
    db.finalizeMessage(assistant.id, {
      content: '4489',
      status: 'complete',
      metadata: {
        metrics: {
          toolCards: [{
            name: 'calculate',
            display: {
              calculator: {
                expression: '67*67',
                result: '4489'
              }
            }
          }]
        }
      }
    });

    const context = db.getVisibleContext(db.getChat(chat.id));
    assert.match(context.at(-1).content, /4489/);
    assert.match(context.at(-1).content, /calculator result: 67\*67 = 4489/);
  } finally {
    cleanup();
  }
});
