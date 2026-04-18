import { create } from 'zustand'
import { persist } from 'zustand/middleware'

function revokeMessageAttachmentUrls(messages = []) {
  for (const message of messages || []) {
    for (const attachment of message.attachments || []) {
      if (typeof attachment.url === 'string' && attachment.url.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.url)
      }
    }
  }
}

const useStore = create(
  persist(
    (set) => ({
      theme: 'minimal',
      setTheme: (theme) => set({ theme }),
      colorMode: 'system',
      setColorMode: (colorMode) => set({ colorMode }),
      userName: '',
      setUserName: (userName) => set({ userName }),
      showMetrics: true,
      setShowMetrics: (showMetrics) => set({ showMetrics }),
      webSearchEnabled: true,
      setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),
      contextSize: 32768,
      setContextSize: (contextSize) => set({ contextSize }),
      modelResidency: 'always_hot',
      setModelResidency: (modelResidency) => set({ modelResidency }),
      toolActivities: [],
      addToolActivity: (activity) =>
        set((s) => ({
          toolActivities: [
            {
              id: activity.toolCallId || `tool${Date.now()}${Math.random().toString(36).slice(2)}`,
              at: Date.now(),
              ...activity,
            },
            ...s.toolActivities,
          ].slice(0, 6),
        })),
      clearToolActivities: () => set({ toolActivities: [] }),
      streamToolCards: [],
      addStreamToolCard: (card) =>
        set((s) => ({
          streamToolCards: (() => {
            const nextCard = {
              id: card.toolCallId || card.id || `toolcard${Date.now()}${Math.random().toString(36).slice(2)}`,
              at: Date.now(),
              ...card,
            }
            const index = s.streamToolCards.findIndex((item) => item.toolCallId && item.toolCallId === nextCard.toolCallId)
            if (index < 0) return [...s.streamToolCards, nextCard].slice(-8)
            const next = [...s.streamToolCards]
            next[index] = { ...next[index], ...nextCard }
            return next.slice(-8)
          })(),
        })),
      clearStreamToolCards: () => set({ streamToolCards: [] }),
      timers: [],
      stopwatches: [],
      applyClientToolAction: (action) =>
        set((s) => {
          const now = Date.now()
          if (action.action === 'timer_start') {
            const durationMs = Math.max(1, Number(action.durationMs || 0))
            return {
              timers: [
                ...s.timers,
                {
                  id: `timer${now}${Math.random().toString(36).slice(2)}`,
                  label: action.label || 'Timer',
                  durationMs,
                  targetAt: now + durationMs,
                  createdAt: now,
                  status: 'active',
                  toolCallId: action.toolCallId || null,
                },
              ],
            }
          }
          if (action.action === 'timer_cancel') {
            return { timers: s.timers.map((timer) => timer.id === action.id ? { ...timer, status: 'cancelled' } : timer) }
          }
          if (action.action === 'stopwatch_start') {
            return {
              stopwatches: [
                ...s.stopwatches,
                {
                  id: `sw${now}${Math.random().toString(36).slice(2)}`,
                  label: action.label || 'Stopwatch',
                  startedAt: now,
                  elapsedMs: 0,
                  running: true,
                  toolCallId: action.toolCallId || null,
                },
              ],
            }
          }
          if (action.action === 'stopwatch_stop') {
            return {
              stopwatches: s.stopwatches.map((watch) => watch.id === action.id && watch.running
                ? { ...watch, elapsedMs: watch.elapsedMs + now - watch.startedAt, running: false }
                : watch),
            }
          }
          if (action.action === 'stopwatch_reset') {
            return {
              stopwatches: s.stopwatches.map((watch) => watch.id === action.id
                ? { ...watch, elapsedMs: 0, startedAt: now, running: false }
                : watch),
            }
          }
          return {}
        }),

      // Models
      models: [],
      selectedModel: '',
      setModels: (models) => set({ models }),
      setSelectedModel: (m) => set({ selectedModel: m }),
      pendingAttachments: [],
      addPendingAttachments: (files) =>
        set((s) => ({
          pendingAttachments: [
            ...s.pendingAttachments,
            ...Array.from(files || []).map((file) => ({
              id: `att${Date.now()}${Math.random().toString(36).slice(2)}`,
              file,
              name: file.name || 'image',
              mimeType: file.type || 'image/jpeg',
              sizeBytes: file.size || 0,
              previewUrl: URL.createObjectURL(file),
            })),
          ].slice(0, 8),
        })),
      removePendingAttachment: (id) =>
        set((s) => {
          const removed = s.pendingAttachments.find((item) => item.id === id)
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
          return { pendingAttachments: s.pendingAttachments.filter((item) => item.id !== id) }
        }),
      clearPendingAttachments: () =>
        set((s) => {
          s.pendingAttachments.forEach((item) => {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
          })
          return { pendingAttachments: [] }
        }),

      // Chats
      chats: [],
      currentChatId: null,
      setChats: (chats) => set({ chats }),
      setCurrentChatId: (id) => set({ currentChatId: id }),

      messages: [],
      messagesByChat: {},
      setMessages: (messages) =>
        set((s) => {
          revokeMessageAttachmentUrls(s.messages)
          return {
            messages,
            messagesByChat: s.currentChatId
              ? { ...s.messagesByChat, [s.currentChatId]: messages }
              : s.messagesByChat,
          }
        }),
      setMessagesForChat: (chatId, messages) =>
        set((s) => {
          revokeMessageAttachmentUrls(s.messagesByChat[chatId])
          if (s.currentChatId === chatId && s.messages !== s.messagesByChat[chatId]) {
            revokeMessageAttachmentUrls(s.messages)
          }
          return {
            messagesByChat: { ...s.messagesByChat, [chatId]: messages },
            messages: s.currentChatId === chatId ? messages : s.messages,
          }
        }),
      appendMessage: (msg) =>
        set((s) => {
          const chatId = msg.chatId || s.currentChatId
          const next = [...(s.messagesByChat[chatId] || s.messages), { ...msg, chatId }]
          return {
            messages: chatId === s.currentChatId ? next : s.messages,
            messagesByChat: { ...s.messagesByChat, [chatId]: next },
          }
        }),

      isStreaming: false,
      streamingContent: '',
      streamController: null,
      streamMetrics: null,
      queuedMessages: [],
      setIsStreaming: (v) => set({ isStreaming: v }),
      setStreamingContent: (c) => set({ streamingContent: c }),
      appendStreamingContent: (chunk) =>
        set((s) => {
          const now = performance.now()
          const metrics = s.streamMetrics || { startedAt: now, firstTokenAt: null, tokens: 0 }
          return {
            streamingContent: s.streamingContent + chunk,
            streamMetrics: {
              ...metrics,
              firstTokenAt: metrics.firstTokenAt || now,
              tokens: metrics.tokens + 1,
              updatedAt: now,
            },
          }
        }),
      setStreamController: (c) => set({ streamController: c }),
      startStreamMetrics: () => set({ streamMetrics: { startedAt: performance.now(), firstTokenAt: null, tokens: 0, updatedAt: performance.now() } }),
      clearStreamMetrics: () => set({ streamMetrics: null }),
      enqueueMessage: (msg) =>
        set((s) => ({ queuedMessages: [...s.queuedMessages, { id: `q${Date.now()}${s.queuedMessages.length}`, ...msg }] })),
      shiftQueuedMessage: () => {
        let next = null
        set((s) => {
          next = s.queuedMessages[0] || null
          return { queuedMessages: s.queuedMessages.slice(1) }
        })
        return next
      },
      clearQueuedMessages: () => set({ queuedMessages: [] }),

      input: '',
      setInput: (v) => set({ input: v }),

      error: null,
      setError: (e) => set({ error: e }),
    }),
    {
      name: 'naow-persist',
      partialize: (s) => ({
        theme: s.theme,
        colorMode: s.colorMode,
        userName: s.userName,
        selectedModel: s.selectedModel,
        showMetrics: s.showMetrics,
        webSearchEnabled: s.webSearchEnabled,
        contextSize: s.contextSize,
        modelResidency: s.modelResidency,
        timers: s.timers,
        stopwatches: s.stopwatches,
      }),
    }
  )
)

export default useStore
