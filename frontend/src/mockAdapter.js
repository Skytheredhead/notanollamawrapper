// ─── MOCK ADAPTER ─────────────────────────────────────────────────────────────
// Used when backend is unavailable. Clearly isolated — never ship as primary.
// All state is in-memory and resets on page reload.

const MODELS = ['llama3:8b', 'mistral:7b', 'phi3:mini', 'gemma2:9b', 'codellama:13b']

const RESPONSES = [
  `I'm a mock response from **naow** (notanollamawrapper). The real backend isn't connected yet.\n\nOpen Settings to switch between Minimal, Windows Classic, Comic Book, and Terminal themes.\n\nHere's a quick code sample:\n\`\`\`python\ndef greet(name: str) -> str:\n    return f"Hello from naow, {name}!"\n\nprint(greet("world"))\n\`\`\``,
  `Sure. The frontend is now one chat surface with theme variants instead of separate UI pages.\n\nThe \`useChat\` hook centralizes sending, streaming, regenerating, stopping, and chat selection. The shell handles the search bar, settings, metrics, and swipe carousel.\n\nThis mock adapter simulates streaming by drip-feeding words with a small random delay.`,
  `A few useful details:\n\n1. **Local-first** — everything runs on your machine\n2. **Swipe carousel** — move between chats horizontally\n3. **Streaming metrics** — token rate and first-token timing can show under replies\n4. **Stop** — abort generation mid-stream\n5. **Regenerate** — re-run the last assistant response\n\nTheme and metric preferences persist in localStorage.`,
  `Here's some inline \`code\` and a longer block:\n\`\`\`javascript\n// useChat.js pattern\nconst { sendMessage, stopGeneration } = useChat()\n\n// Send a message\nawait sendMessage() // reads from store.input\n\n// Stop mid-stream\nstopGeneration()\n\`\`\`\nThe adapter interface is defined in \`src/adapter.js\` — just point it at your backend URL.`,
  `Interesting. I should mention that as a mock adapter I don't actually have any real knowledge; I'm cycling through pre-written responses to let you evaluate the UI.\n\nThe streaming simulation is real: words appear one by one, stop works mid-stream, and the generated reply tracks local timing metrics.`,
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let cidx = 2
let chats = [
  { id: 'c1', title: 'Welcome to naow', model: 'llama3:8b', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
]
const msgs = {
  c1: [
    { id: 'm1', role: 'user', content: 'What is naow?' },
    { id: 'm2', role: 'assistant', content: 'naow (notanollamawrapper) is a local chat UI with a minimal default surface, themeable settings, search, streaming, and a smooth chat carousel. This mock adapter is running because the backend is not connected yet.' },
  ],
}

const mockAdapter = {
  async health() { return { ok: true, mock: true } },

  async listModels() {
    await sleep(80)
    return [...MODELS]
  },

  async unloadModels() {
    await sleep(120)
    return { unloaded: [...MODELS], count: MODELS.length }
  },

  async stats(model = MODELS[0]) {
    await sleep(30)
    return {
      timestamp: new Date().toISOString(),
      backend: {
        id: model.includes('/') ? 'mlx' : 'ollama',
        label: model.includes('/') ? 'MLX' : 'Ollama',
      },
      cpu: { usagePercent: 8.4 },
      ram: { rssBytes: 640 * 1024 * 1024 },
      gpu: { available: true, usagePercent: 31, source: 'mock' },
      process: { pid: 0, processCount: 1, pids: [] },
    }
  },

  async mlxModelsStatus() {
    return {
      status: 'done',
      pct: 100,
      step: 'models ready',
      modelsDir: 'mock',
      missing: [],
      promptState: 'complete',
      models: [{
        key: 'qwen3_5_9b_mlx_4bit',
        name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
        label: 'Qwen3.5 9B MLX 4-bit',
        ready: true,
      }],
    }
  },

  async mlxPreflight() { return { ok: true, message: 'MLX mock ready.' } },
  async startMlxModelDownload() { return this.mlxModelsStatus() },
  async mlxModelDownloadStatus() { return this.mlxModelsStatus() },
  async openMlxModelsFolder() { return { opened: true, path: 'mock' } },
  async preSearchAnalyze() { return { used: false, skipped: 'mock' } },
  async summarizeSources(sources = []) {
    return {
      sources: sources.map((source) => ({
        ...source,
        domain: source.domain || 'example.com',
        faviconUrl: source.faviconUrl || '',
        summary: source.summary || source.snippet || 'Mock source summary.',
      })),
    }
  },

  async listChats() {
    await sleep(40)
    return [...chats]
  },

  async createChat(title = 'New Chat', model = MODELS[0]) {
    await sleep(40)
    const now = new Date().toISOString()
    const chat = { id: `c${++cidx}`, title, model, createdAt: now, updatedAt: now }
    chats = [chat, ...chats]
    msgs[chat.id] = []
    return chat
  },

  async loadChat(id) {
    await sleep(40)
    const chat = chats.find((c) => c.id === id) ?? null
    return { chat, messages: [...(msgs[id] ?? [])] }
  },

  sendMessage(chatId, content, model, options, webSearch, attachments, onToken, onDone, onError) {
    const ctrl = { aborted: false, abort() { this.aborted = true } }

    if (!msgs[chatId]) msgs[chatId] = []
    msgs[chatId].push({ id: `m${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString() })

    const chat = chats.find((c) => c.id === chatId)
    if (chat && msgs[chatId].length === 1) chat.title = content.slice(0, 42) + (content.length > 42 ? '…' : '')

    const reply = RESPONSES[Math.floor(Math.random() * RESPONSES.length)]

    ;(async () => {
      await sleep(180)
      let accumulated = ''
      const tokens = reply.split(/(\s+)/)
      for (const tok of tokens) {
        if (ctrl.aborted) { onDone({ aborted: true }); return }
        onToken(tok)
        accumulated += tok
        await sleep(25 + Math.random() * 45)
      }
      msgs[chatId].push({ id: `m${Date.now() + 1}`, role: 'assistant', content: accumulated, createdAt: new Date().toISOString() })
      if (chat) chat.updatedAt = new Date().toISOString()
      onDone({})
    })()

    return ctrl
  },

  stopGeneration(ctrl) { ctrl?.abort?.() },

  regenerate(chatId, model, options, webSearch, onToken, onDone, onError) {
    const chatMsgs = msgs[chatId] ?? []
    if (chatMsgs.length > 0 && chatMsgs[chatMsgs.length - 1].role === 'assistant') {
      msgs[chatId] = chatMsgs.slice(0, -1)
    }
    const reply = RESPONSES[Math.floor(Math.random() * RESPONSES.length)]
    const ctrl = { aborted: false, abort() { this.aborted = true } }

    ;(async () => {
      await sleep(150)
      let accumulated = ''
      const tokens = reply.split(/(\s+)/)
      for (const tok of tokens) {
        if (ctrl.aborted) { onDone({ aborted: true }); return }
        onToken(tok)
        accumulated += tok
        await sleep(25 + Math.random() * 45)
      }
      if (!msgs[chatId]) msgs[chatId] = []
      msgs[chatId].push({ id: `m${Date.now()}`, role: 'assistant', content: accumulated, createdAt: new Date().toISOString() })
      onDone({})
    })()

    return ctrl
  },

  editMessage(chatId, messageId, content, model, options, webSearch, onToken, onDone, onError) {
    const chatMsgs = msgs[chatId] ?? []
    const index = chatMsgs.findIndex((message) => message.id === messageId && message.role === 'user')
    if (index >= 0) {
      msgs[chatId] = [...chatMsgs.slice(0, index), { ...chatMsgs[index], content }]
    }
    return this.regenerate(chatId, model, options, webSearch, onToken, onDone, onError)
  },
}

export default mockAdapter
