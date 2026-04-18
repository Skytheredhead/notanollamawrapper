const BASE = import.meta.env.VITE_API_URL || '/api'
const ROOT = BASE.replace(/\/api\/?$/, '')

async function* readStream(response) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const parseFrame = (frame) => {
    const lines = frame.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return null
    try {
      const payload = JSON.parse(data)
      return event ? { event, ...payload } : payload
    } catch {
      return null
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop()
    for (const frame of frames) {
      const parsed = parseFrame(frame.trim())
      if (parsed) yield parsed
    }
  }
  const parsed = parseFrame(buf.trim())
  if (parsed) yield parsed
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

  async unloadModels() {
    const r = await fetch(`${BASE}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!r.ok) throw new Error(`unloadModels: ${r.status}`)
    return r.json()
  },

  async stats(model) {
    const query = model ? `?model=${encodeURIComponent(model)}` : ''
    const r = await fetch(`${BASE}/stats${query}`)
    if (!r.ok) throw new Error(`stats: ${r.status}`)
    return r.json()
  },

  async searchStatus() {
    const r = await fetch(`${BASE}/search/status`)
    if (!r.ok) throw new Error(`searchStatus: ${r.status}`)
    return r.json()
  },

  async startSearch() {
    const r = await fetch(`${BASE}/search/start`, { method: 'POST' })
    if (!r.ok) throw new Error(`startSearch: ${r.status}`)
    return r.json()
  },

  async mlxStatus() {
    const r = await fetch(`${BASE}/mlx/status`)
    if (!r.ok) throw new Error(`mlxStatus: ${r.status}`)
    return r.json()
  },

  async mlxPreflight() {
    const r = await fetch(`${BASE}/mlx/preflight`)
    if (!r.ok) throw new Error(`mlxPreflight: ${r.status}`)
    return r.json()
  },

  async mlxModelsStatus() {
    const r = await fetch(`${BASE}/mlx/models/status`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!r.ok) throw new Error(`mlxModelsStatus: ${r.status}`)
    return r.json()
  },

  async startMlxModelDownload(modelKey) {
    const r = await fetch(`${BASE}/mlx/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelKey }),
    })
    if (!r.ok) throw new Error(`startMlxModelDownload: ${r.status}`)
    return r.json()
  },

  async mlxModelDownloadStatus() {
    const r = await fetch(`${BASE}/mlx/models/download/status`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!r.ok) throw new Error(`mlxModelDownloadStatus: ${r.status}`)
    return r.json()
  },

  async openMlxModelsFolder() {
    const r = await fetch(`${BASE}/mlx/models/open-folder`, { method: 'POST' })
    if (!r.ok) throw new Error(`openMlxModelsFolder: ${r.status}`)
    return r.json()
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

  sendMessage(chatId, content, model, options, webSearch, attachments, onToken, onDone, onError, tools, onToolEvent) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        let body
        let headers
        if (attachments?.length) {
          body = new FormData()
          body.append('content', content)
          body.append('model', model || '')
          body.append('options', JSON.stringify(options || {}))
          body.append('webSearch', String(webSearch))
          body.append('tools', JSON.stringify(tools || { enabled: true }))
          attachments.forEach((attachment) => body.append('attachments', attachment.file, attachment.name))
        } else {
          headers = { 'Content-Type': 'application/json' }
          body = JSON.stringify({ content, model, options, webSearch, tools: tools || { enabled: true } })
        }
        const r = await fetch(`${BASE}/chats/${chatId}/messages`, {
          method: 'POST',
          headers,
          body,
          signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`sendMessage: ${r.status}`)
        for await (const chunk of readStream(r)) {
          if (chunk.error) throw new Error(chunk.error.message || 'Generation failed')
          if (chunk.event?.startsWith('tool_call') || chunk.event === 'client_tool_action' || chunk.event === 'web_search') {
            onToolEvent?.(chunk)
          }
          const tok = chunk.delta ?? chunk.token ?? chunk.content ?? chunk.text ?? ''
          if (tok) onToken(tok)
          if (chunk.done || chunk.event === 'message_complete') { onDone(chunk); return }
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

  regenerate(chatId, model, options, webSearch, onToken, onDone, onError, tools, onToolEvent) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${BASE}/chats/${chatId}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, options, webSearch, tools: tools || { enabled: true } }),
          signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`regenerate: ${r.status}`)
        for await (const chunk of readStream(r)) {
          if (chunk.error) throw new Error(chunk.error.message || 'Generation failed')
          if (chunk.event?.startsWith('tool_call') || chunk.event === 'client_tool_action' || chunk.event === 'web_search') {
            onToolEvent?.(chunk)
          }
          const tok = chunk.delta ?? chunk.token ?? chunk.content ?? chunk.text ?? ''
          if (tok) onToken(tok)
          if (chunk.done || chunk.event === 'message_complete') { onDone(chunk); return }
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
