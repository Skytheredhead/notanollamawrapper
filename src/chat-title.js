function chatNeedsAutoTitle(chat) {
  const t = String(chat?.title || '').trim().toLowerCase();
  return t === 'new chat' || t === '';
}

function sanitizeGeneratedTitle(raw) {
  let s = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .replace(/\.+$/g, '')
    .trim();
  if (s.length > 120) s = s.slice(0, 117).trim() + '…';
  return s;
}

/**
 * After the first visible user message, rename chats still titled "New chat" using the small MLX model.
 * Fire-and-forget; does not block streaming.
 */
export async function maybeAutoTitleChatFromFirstUserMessage({ db, ollama, config, chatId, userContent }) {
  const chat = db.getChat(chatId);
  if (!chat || !chatNeedsAutoTitle(chat)) return;

  const messages = db.getMessages(chatId);
  const userVisible = messages.filter((m) => m.role === 'user' && m.status !== 'replaced');
  if (userVisible.length !== 1) return;

  const model = config.preSearchModel;
  if (!model || typeof ollama?.completeChat !== 'function') return;

  const snippet = String(userContent || '').trim().slice(0, 2400);
  if (snippet.length < 2) return;

  try {
    const result = await ollama.completeChat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Reply with ONLY a short conversation title: 2–6 words, Title Case, no quotes, no emojis, no trailing punctuation. Describe the user\'s topic.'
        },
        { role: 'user', content: snippet }
      ],
      options: {
        max_tokens: 40,
        temperature: 0,
        enable_thinking: false
      }
    });
    const raw = String(result?.message?.content || result?.content || '').trim();
    const title = sanitizeGeneratedTitle(raw);
    if (title.length < 2) return;

    const again = db.getChat(chatId);
    if (!again || !chatNeedsAutoTitle(again)) return;
    db.updateChatTitle(chatId, title);
  } catch {
    // best-effort
  }
}
