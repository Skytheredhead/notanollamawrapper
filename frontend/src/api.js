const BASE = import.meta.env.VITE_API_URL || '/api'
const ROOT = BASE.replace(/\/api\/?$/, '')

async function readErrorPayload(response) {
  // Try to extract { error: { code, message, requestId, details } }.
  const contentType = response.headers.get('content-type') || ''
  try {
    if (contentType.includes('application/json')) {
      const j = await response.json()
      if (j?.error) return j.error
      if (j?.message || j?.code) return j
    }
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (!text) return null
    try {
      const j = JSON.parse(text)
      if (j?.error) return j.error
      if (j?.message || j?.code) return j
    } catch { /* ignore */ }
    return { message: text.slice(0, 800) }
  } catch { /* ignore */ }
  return null
}

function formatApiError(context, status, payload) {
  const message = payload?.message || payload?.error || payload?.detail || null
  const code = payload?.code || null
  const requestId = payload?.requestId || null
  const details = payload?.details || null
  const bits = []
  if (context) bits.push(context)
  bits.push(`${status}`)
  if (code) bits.push(code)
  if (message) bits.push(message)
  if (requestId) bits.push(`requestId=${requestId}`)
  const err = new Error(bits.join(': '))
  err.status = status
  if (code) err.code = code
  if (requestId) err.requestId = requestId
  if (details) err.details = details
  return err
}

async function assertOk(response, context = '') {
  if (response.ok) return response
  const payload = await readErrorPayload(response)
  throw formatApiError(context, response.status, payload)
}

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
    await assertOk(r, 'listModels')
    const d = await r.json()
    const models = Array.isArray(d) ? d : (d.models ?? [])
    return models.map((m) => typeof m === 'string' ? m : m.name).filter(Boolean)
  },

  async unloadModels() {
    const r = await fetch(`${BASE}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    await assertOk(r, 'unloadModels')
    return r.json()
  },

  async stats(model) {
    const query = model ? `?model=${encodeURIComponent(model)}` : ''
    const r = await fetch(`${BASE}/stats${query}`)
    await assertOk(r, 'stats')
    return r.json()
  },

  async searchStatus() {
    const r = await fetch(`${BASE}/search/status`)
    await assertOk(r, 'searchStatus')
    return r.json()
  },

  async startSearch() {
    const r = await fetch(`${BASE}/search/start`, { method: 'POST' })
    await assertOk(r, 'startSearch')
    return r.json()
  },

  async mlxStatus() {
    const r = await fetch(`${BASE}/mlx/status`)
    await assertOk(r, 'mlxStatus')
    return r.json()
  },

  async mlxPreflight() {
    const r = await fetch(`${BASE}/mlx/preflight`)
    await assertOk(r, 'mlxPreflight')
    return r.json()
  },

  async mlxModelsStatus() {
    const r = await fetch(`${BASE}/mlx/models/status`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
    await assertOk(r, 'mlxModelsStatus')
    return r.json()
  },

  async startMlxRunner() {
    const r = await fetch(`${BASE}/mlx/start`, { method: 'POST' })
    await assertOk(r, 'startMlxRunner')
    return r.json()
  },

  async stopMlxRunner() {
    const r = await fetch(`${BASE}/mlx/stop`, { method: 'POST' })
    await assertOk(r, 'stopMlxRunner')
    return r.json()
  },

  async startMlxModelDownload(modelKey) {
    const r = await fetch(`${BASE}/mlx/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelKey }),
    })
    await assertOk(r, 'startMlxModelDownload')
    return r.json()
  },

  async mlxModelDownloadStatus() {
    const r = await fetch(`${BASE}/mlx/models/download/status`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
    await assertOk(r, 'mlxModelDownloadStatus')
    return r.json()
  },

  async openMlxModelsFolder() {
    const r = await fetch(`${BASE}/mlx/models/open-folder`, { method: 'POST' })
    await assertOk(r, 'openMlxModelsFolder')
    return r.json()
  },

  async preSearchAnalyze(chatId, draft, options = {}, signal) {
    const r = await fetch(`${BASE}/presearch/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        draft,
        enabled: options.enabled !== false,
        webSearch: options.webSearch !== false,
        hasAttachments: Boolean(options.hasAttachments),
        previousPreSearchId: options.previousPreSearchId || null,
      }),
      signal,
    })
    await assertOk(r, 'preSearchAnalyze')
    return r.json()
  },

  async summarizeSources(sources = []) {
    const r = await fetch(`${BASE}/sources/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
    })
    await assertOk(r, 'summarizeSources')
    return r.json()
  },

  async summarizeSourcesStream(sources = [], { signal, onSource } = {}) {
    const r = await fetch(`${BASE}/sources/summarize?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
      signal,
    })
    await assertOk(r, 'summarizeSourcesStream')
    const reader = r.body?.getReader()
    if (!reader) throw new Error('summarizeSourcesStream: no body')
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: !done })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const item = JSON.parse(line)
        onSource?.(item)
      }
      if (done) break
    }
    const tail = buffer.trim()
    if (tail) {
      const item = JSON.parse(tail)
      onSource?.(item)
    }
  },

  async listChats() {
    const r = await fetch(`${BASE}/chats`)
    await assertOk(r, 'listChats')
    const d = await r.json()
    return Array.isArray(d) ? d : (d.chats ?? [])
  },

  async createChat(title = 'New Chat', model = '') {
    const r = await fetch(`${BASE}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, model }),
    })
    await assertOk(r, 'createChat')
    const d = await r.json()
    return d.chat ?? d
  },

  async loadChat(id) {
    const r = await fetch(`${BASE}/chats/${id}`)
    await assertOk(r, 'loadChat')
    return r.json()
  },

  async setSystemPrompt(chatId, systemPrompt) {
    const r = await fetch(`${BASE}/chats/${encodeURIComponent(chatId)}/system-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    })
    await assertOk(r, 'setSystemPrompt')
    return r.json()
  },

  sendMessage(chatId, content, model, options, webSearch, attachments, onToken, onDone, onError, tools, onToolEvent, preSearchId = null, searchStrategy = 'normal') {
    const ctrl = new AbortController()
    const clientMessageId = (globalThis.crypto?.randomUUID?.() || `cmsg_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    ;(async () => {
      const isBackendOfflineError = (error) => {
        const code = String(error?.code || '')
        const message = String(error?.message || '')
        return code === 'mlx_stream_failed' || /could not reach mlx runner/i.test(message)
      }

      const doRequest = async () => {
        let body
        let headers
        if (attachments?.length) {
          body = new FormData()
          body.append('content', content)
          body.append('clientMessageId', clientMessageId)
          body.append('model', model || '')
          body.append('options', JSON.stringify(options || {}))
          body.append('webSearch', String(webSearch))
          if (preSearchId) body.append('preSearchId', preSearchId)
          body.append('searchStrategy', searchStrategy)
          body.append('tools', JSON.stringify(tools || { enabled: true }))
          attachments.forEach((attachment) => body.append('attachments', attachment.file, attachment.name))
        } else {
          headers = { 'Content-Type': 'application/json' }
          body = JSON.stringify({ content, clientMessageId, model, options, webSearch, tools: tools || { enabled: true }, preSearchId, searchStrategy })
        }
        const r = await fetch(`${BASE}/chats/${chatId}/messages`, {
          method: 'POST',
          headers,
          body,
          signal: ctrl.signal,
        })
        await assertOk(r, 'sendMessage')
        return r
      }

      try {
        let attemptedAutoStart = false
        while (true) {
          const r = await doRequest()
          let shouldRetry = false
          for await (const chunk of readStream(r)) {
            if (chunk.error) {
              if (!attemptedAutoStart && isBackendOfflineError(chunk.error) && typeof realAdapter.startMlxRunner === 'function') {
                attemptedAutoStart = true
                try {
                  await realAdapter.startMlxRunner()
                  shouldRetry = true
                } catch (e) {
                  throw new Error(e?.message || 'Backend offline.')
                }
                break
              }
              const err = new Error(chunk.error.message || 'Generation failed')
              if (chunk.error.code) err.code = chunk.error.code
              if (chunk.error.requestId) err.requestId = chunk.error.requestId
              if (chunk.error.details) err.details = chunk.error.details
              throw err
            }
            if (
              chunk.event === 'generation_start' ||
              chunk.event?.startsWith('tool_call') ||
              chunk.event === 'client_tool_action' ||
              chunk.event === 'web_search' ||
              chunk.event === 'search_status'
            ) {
              onToolEvent?.(chunk)
            }
            const tok = chunk.delta ?? chunk.token ?? chunk.content ?? chunk.text ?? ''
            if (tok) onToken(tok)
            if (chunk.done || chunk.event === 'message_complete') { onDone(chunk); return }
          }
          if (!shouldRetry) break
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

  regenerate(chatId, model, options, webSearch, onToken, onDone, onError, tools, onToolEvent, regenerateOptions = {}) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${BASE}/chats/${chatId}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            options,
            webSearch,
            tools: tools || { enabled: true },
            messageId: regenerateOptions.messageId || null,
            searchMode: regenerateOptions.searchMode || 'normal',
            searchStrategy: regenerateOptions.searchStrategy || 'normal',
          }),
          signal: ctrl.signal,
        })
        await assertOk(r, 'regenerate')
        for await (const chunk of readStream(r)) {
          if (chunk.error) {
            const err = new Error(chunk.error.message || 'Generation failed')
            if (chunk.error.code) err.code = chunk.error.code
            if (chunk.error.requestId) err.requestId = chunk.error.requestId
            if (chunk.error.details) err.details = chunk.error.details
            throw err
          }
          if (
            chunk.event === 'generation_start' ||
            chunk.event?.startsWith('tool_call') ||
            chunk.event === 'client_tool_action' ||
            chunk.event === 'web_search' ||
            chunk.event === 'search_status'
          ) {
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

  editMessage(chatId, messageId, content, model, options, webSearch, onToken, onDone, onError, tools, onToolEvent, editOptions = {}) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${BASE}/chats/${chatId}/messages/${messageId}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            model,
            options,
            webSearch,
            tools: tools || { enabled: true },
            searchStrategy: editOptions.searchStrategy || 'normal',
          }),
          signal: ctrl.signal,
        })
        await assertOk(r, 'editMessage')
        for await (const chunk of readStream(r)) {
          if (chunk.error) {
            const err = new Error(chunk.error.message || 'Generation failed')
            if (chunk.error.code) err.code = chunk.error.code
            if (chunk.error.requestId) err.requestId = chunk.error.requestId
            if (chunk.error.details) err.details = chunk.error.details
            throw err
          }
          if (
            chunk.event === 'generation_start' ||
            chunk.event?.startsWith('tool_call') ||
            chunk.event === 'client_tool_action' ||
            chunk.event === 'web_search' ||
            chunk.event === 'search_status'
          ) {
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

  async getDeepResearch(chatId) {
    const r = await fetch(`${BASE}/chats/${encodeURIComponent(chatId)}/deep-research`)
    if (r.status === 404) return { phase: 'idle' }
    await assertOk(r, 'getDeepResearch')
    return r.json()
  },

  async startDeepResearch(chatId, topic) {
    const r = await fetch(`${BASE}/chats/${encodeURIComponent(chatId)}/deep-research/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    })
    await assertOk(r, 'startDeepResearch')
    return r.json()
  },

  async stopDeepResearch(chatId) {
    const r = await fetch(`${BASE}/chats/${encodeURIComponent(chatId)}/deep-research/stop`, { method: 'POST' })
    await assertOk(r, 'stopDeepResearch')
    return r.json()
  },

  async stopAllDeepResearch() {
    const r = await fetch(`${BASE}/deep-research/stop-all`, { method: 'POST' })
    await assertOk(r, 'stopAllDeepResearch')
    return r.json()
  },

  async retryDeepResearch(chatId) {
    const r = await fetch(`${BASE}/chats/${encodeURIComponent(chatId)}/deep-research/retry`, { method: 'POST' })
    await assertOk(r, 'retryDeepResearch')
    return r.json()
  },
}

export default realAdapter
