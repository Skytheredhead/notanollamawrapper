const BASE = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5050/api'
const ROOT = BASE.replace(/\/api\/?$/, '')

async function* readStream(response) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') return
        try { yield JSON.parse(raw) } catch { /* skip malformed */ }
      } else if (line.trim()) {
        try { yield JSON.parse(line) } catch { /* skip */ }
      }
    }
  }
}

const realAdapter = {
  async health() {
    try {
      const r = await fetch(`${ROOT}/health`)
      return { ok: r.ok }
    } catch { return { ok: false } }
  },

  async listModels() {
    const r = await fetch(`${BASE}/models`)
    if (!r.ok) throw new Error(`listModels: ${r.status}`)
    const d = await r.json()
    const models = Array.isArray(d) ? d : (d.models ?? [])
    return models.map((m) => typeof m === 'string' ? m : m.name).filter(Boolean)
  },

  async listChats() {
    const r = await fetch(`${BASE}/chats`)
    if (!r.ok) throw new Error(`listChats: ${r.status}`)
    const d = await r.json()
    return Array.isArray(d) ? d : (d.chats ?? [])
  },

  async createChat(title = 'New Chat', model = '') {
    const r = await fetch(`${BASE}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, model }),
    })
    if (!r.ok) throw new Error(`createChat: ${r.status}`)
    const d = await r.json()
    return d.chat ?? d
  },

  async loadChat(id) {
    const r = await fetch(`${BASE}/chats/${id}`)
    if (!r.ok) throw new Error(`loadChat: ${r.status}`)
    return r.json()
  },

  sendMessage(chatId, content, model, onToken, onDone, onError) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${BASE}/chats/${chatId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, model }),
          signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`sendMessage: ${r.status}`)
        for await (const chunk of readStream(r)) {
          const tok = chunk.delta ?? chunk.token ?? chunk.content ?? chunk.text ?? ''
          if (tok) onToken(tok)
          if (chunk.done) { onDone(chunk); return }
        }
        onDone({})
      } catch (e) {
        if (e.name === 'AbortError') onDone({ aborted: true })
        else onError(e)
      }
    })()
    return ctrl
  },

  stopGeneration(ctrl) { ctrl?.abort() },

  regenerate(chatId, model, onToken, onDone, onError) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${BASE}/chats/${chatId}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`regenerate: ${r.status}`)
        for await (const chunk of readStream(r)) {
          const tok = chunk.delta ?? chunk.token ?? chunk.content ?? chunk.text ?? ''
          if (tok) onToken(tok)
          if (chunk.done) { onDone(chunk); return }
        }
        onDone({})
      } catch (e) {
        if (e.name === 'AbortError') onDone({ aborted: true })
        else onError(e)
      }
    })()
    return ctrl
  },
}

export default realAdapter
