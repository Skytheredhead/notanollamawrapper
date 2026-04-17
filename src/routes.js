import { badRequest, conflict, notFound, sendError, unavailable } from './errors.js';
import { GenerationInProgressError } from './generation-manager.js';
import { OllamaStreamError, OllamaUnavailableError } from './ollama.js';
import { startPing, startSse, writeSse } from './sse.js';

function requireString(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function optionsFromBody(body) {
  if (!body || typeof body.options !== 'object' || Array.isArray(body.options)) {
    return undefined;
  }
  return body.options;
}

function resolveModel({ body, chat, config }) {
  return requireString(body?.model) || chat.model || config.defaultModel;
}

function assertChat(db, chatId) {
  const chat = db.getChat(chatId);
  if (!chat) throw notFound('Chat not found.');
  return chat;
}

function buildErrorMessage(error) {
  if (error instanceof OllamaStreamError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Ollama stream failed.';
}

function isAbort(error, entry) {
  return entry.abortController.signal.aborted || error?.name === 'AbortError';
}

async function streamAssistantReply({
  request,
  reply,
  db,
  ollama,
  generationManager,
  chat,
  model,
  messages,
  options,
  assistantMessage,
  entry
}) {
  const response = startSse(reply);
  let content = '';
  let completed = false;
  let disconnected = false;

  const onClose = () => {
    if (!completed && !entry.abortController.signal.aborted) {
      disconnected = true;
      generationManager.stopEntry(entry, 'client_disconnected');
    }
  };

  const ping = startPing(response);
  response.on('close', onClose);

  try {
    await writeSse(response, 'generation_start', {
      chatId: chat.id,
      assistantMessageId: assistantMessage.id,
      generationId: entry.generationId,
      model,
      createdAt: assistantMessage.createdAt
    });

    let doneReason = 'stop';
    for await (const chunk of ollama.streamChat({
      model,
      messages,
      options,
      signal: entry.abortController.signal
    })) {
      if (chunk.type === 'token') {
        content += chunk.delta;
        await writeSse(response, 'token', { delta: chunk.delta });
      } else if (chunk.type === 'done') {
        doneReason = chunk.doneReason;
      }
    }

    const message = db.finalizeMessage(assistantMessage.id, {
      content,
      status: 'complete'
    });
    completed = true;
    await writeSse(response, 'message_complete', {
      message,
      doneReason
    });
  } catch (error) {
    if (isAbort(error, entry)) {
      const reason = disconnected ? 'client_disconnected' : entry.stopReason || 'user_stopped';
      const message = db.finalizeMessage(assistantMessage.id, {
        content,
        status: 'cancelled'
      });
      completed = true;
      await writeSse(response, 'cancelled', {
        message,
        reason
      });
    } else {
      const message = buildErrorMessage(error);
      db.finalizeMessage(assistantMessage.id, {
        content,
        status: 'error',
        error: message
      });
      completed = true;
      await writeSse(response, 'error', {
        error: {
          code: 'ollama_stream_failed',
          message
        }
      });
    }
  } finally {
    clearInterval(ping);
    response.off('close', onClose);
    generationManager.finish(entry.generationId);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

function createGeneration({ db, generationManager, chat, model }) {
  let entry;
  try {
    entry = generationManager.start({
      chatId: chat.id,
      assistantMessageId: 'pending'
    });
  } catch (error) {
    if (error instanceof GenerationInProgressError) {
      throw conflict('generation_in_progress', 'This chat already has an active generation.');
    }
    throw error;
  }

  try {
    const assistantMessage = db.createAssistantMessage(chat.id, entry.generationId);
    entry.assistantMessageId = assistantMessage.id;
    db.setChatModelIfEmpty(chat.id, model);
    return { entry, assistantMessage };
  } catch (error) {
    generationManager.finish(entry.generationId);
    throw error;
  }
}

export function registerRoutes(app, { config, db, ollama, generationManager }) {
  app.get('/health', async () => {
    let ollamaHealth;
    try {
      const version = await ollama.getVersion();
      ollamaHealth = {
        ok: true,
        url: config.ollamaBaseUrl,
        version: version.version ?? null
      };
    } catch (error) {
      ollamaHealth = {
        ok: false,
        url: config.ollamaBaseUrl,
        error: error.cause?.message || error.message
      };
    }

    return {
      ok: true,
      name: config.name,
      version: config.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      db: {
        ok: db.isHealthy()
      },
      ollama: ollamaHealth
    };
  });

  app.get('/api/models', async (request, reply) => {
    try {
      const models = await ollama.listModels();
      return { models };
    } catch (error) {
      if (error instanceof OllamaUnavailableError) {
        return sendError(
          reply,
          503,
          'ollama_unavailable',
          `Could not reach Ollama at ${config.ollamaBaseUrl}`
        );
      }
      throw unavailable('ollama_unavailable', `Could not reach Ollama at ${config.ollamaBaseUrl}`);
    }
  });

  app.post('/api/chats', async (request, reply) => {
    const body = request.body || {};
    const chat = db.createChat({
      title: requireString(body.title, 'New chat'),
      model: requireString(body.model),
      systemPrompt: requireString(body.systemPrompt)
    });
    return reply.code(201).send({ chat });
  });

  app.get('/api/chats', async (request) => {
    return db.listChats({
      limit: request.query?.limit,
      cursor: request.query?.cursor
    });
  });

  app.get('/api/chats/:chatId', async (request) => {
    const chat = assertChat(db, request.params.chatId);
    const includeReplaced = request.query?.includeReplaced === 'true';
    return {
      chat,
      messages: db.getMessages(chat.id, { includeReplaced })
    };
  });

  app.post('/api/chats/:chatId/messages', async (request, reply) => {
    const body = request.body || {};
    const content = requireString(body.content);
    if (!content) {
      throw badRequest('empty_message', 'Message content is required.');
    }

    const chat = assertChat(db, request.params.chatId);
    const model = resolveModel({ body, chat, config });
    if (!model) {
      throw badRequest('missing_model', 'Provide a model, set a chat model, or configure NAOW_DEFAULT_MODEL.');
    }

    if (generationManager.getByChat(chat.id)) {
      throw conflict('generation_in_progress', 'This chat already has an active generation.');
    }

    db.createUserMessage(chat.id, content);
    const refreshedChat = db.getChat(chat.id);
    const { entry, assistantMessage } = createGeneration({
      db,
      generationManager,
      chat: refreshedChat,
      model
    });

    const latestChat = db.getChat(chat.id);
    const messages = db.getVisibleContext(latestChat);

    await streamAssistantReply({
      request,
      reply,
      db,
      ollama,
      generationManager,
      chat: latestChat,
      model,
      messages,
      options: optionsFromBody(body),
      assistantMessage,
      entry
    });
  });

  app.post('/api/chats/:chatId/regenerate', async (request, reply) => {
    const body = request.body || {};
    const chat = assertChat(db, request.params.chatId);
    const latestAssistant = db.getLatestVisibleAssistant(chat.id);
    if (!latestAssistant) {
      throw badRequest('nothing_to_regenerate', 'No assistant reply exists to regenerate.');
    }

    const model = resolveModel({ body, chat, config });
    if (!model) {
      throw badRequest('missing_model', 'Provide a model, set a chat model, or configure NAOW_DEFAULT_MODEL.');
    }

    let entry;
    try {
      entry = generationManager.start({
        chatId: chat.id,
        assistantMessageId: 'pending'
      });
    } catch (error) {
      if (error instanceof GenerationInProgressError) {
        throw conflict('generation_in_progress', 'This chat already has an active generation.');
      }
      throw error;
    }

    let messages;
    let assistantMessage;
    let latestChat;
    try {
      messages = db.getVisibleContext(chat, latestAssistant);
      db.markMessageReplaced(latestAssistant.id);
      assistantMessage = db.createAssistantMessage(chat.id, entry.generationId);
      entry.assistantMessageId = assistantMessage.id;
      db.setChatModelIfEmpty(chat.id, model);
      latestChat = db.getChat(chat.id);
    } catch (error) {
      generationManager.finish(entry.generationId);
      throw error;
    }

    await streamAssistantReply({
      request,
      reply,
      db,
      ollama,
      generationManager,
      chat: latestChat,
      model,
      messages,
      options: optionsFromBody(body),
      assistantMessage,
      entry
    });
  });

  app.post('/api/chats/:chatId/stop', async (request) => {
    assertChat(db, request.params.chatId);
    const entry = generationManager.stopByChat(request.params.chatId, 'user_stopped');
    if (!entry) {
      return {
        stopped: false,
        chatId: request.params.chatId
      };
    }

    return {
      stopped: true,
      chatId: request.params.chatId,
      generationId: entry.generationId
    };
  });

  app.post('/api/generations/:generationId/stop', async (request) => {
    const entry = generationManager.stopByGeneration(request.params.generationId, 'user_stopped');
    if (!entry) {
      return {
        stopped: false,
        generationId: request.params.generationId
      };
    }

    return {
      stopped: true,
      generationId: entry.generationId
    };
  });
}
