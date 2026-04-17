import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

      // Models
      models: [],
      selectedModel: '',
      setModels: (models) => set({ models }),
      setSelectedModel: (m) => set({ selectedModel: m }),

      // Chats
      chats: [],
      currentChatId: null,
      setChats: (chats) => set({ chats }),
      setCurrentChatId: (id) => set({ currentChatId: id }),

      messages: [],
      messagesByChat: {},
      setMessages: (messages) =>
        set((s) => ({
          messages,
          messagesByChat: s.currentChatId
            ? { ...s.messagesByChat, [s.currentChatId]: messages }
            : s.messagesByChat,
        })),
      setMessagesForChat: (chatId, messages) =>
        set((s) => ({
          messagesByChat: { ...s.messagesByChat, [chatId]: messages },
          messages: s.currentChatId === chatId ? messages : s.messages,
        })),
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
      partialize: (s) => ({ theme: s.theme, colorMode: s.colorMode, userName: s.userName, selectedModel: s.selectedModel, showMetrics: s.showMetrics }),
    }
  )
)

export default useStore
