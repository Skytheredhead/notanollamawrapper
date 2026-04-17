import { useCallback } from 'react'
import adapter from './adapter'
import useStore from './store'

export function useChat() {
  const {
    models, setModels,
    selectedModel, setSelectedModel,
    chats, setChats,
    currentChatId, setCurrentChatId,
    messages, setMessages, setMessagesForChat, appendMessage,
    streamingContent, setStreamingContent, appendStreamingContent,
    isStreaming, setIsStreaming,
    streamController, setStreamController,
    streamMetrics, startStreamMetrics, clearStreamMetrics,
    queuedMessages, enqueueMessage, shiftQueuedMessage,
    input, setInput,
    setError,
  } = useStore()

  const loadModels = useCallback(async () => {
    try {
      const ms = await adapter.listModels()
      setModels(ms)
      if (ms.length > 0 && !useStore.getState().selectedModel) setSelectedModel(ms[0])
    } catch (e) { setError(e.message) }
  }, [])

  const loadChats = useCallback(async () => {
    try {
      const cs = await adapter.listChats()
      setChats(cs)
      return cs
    } catch (e) { setError(e.message); return [] }
  }, [])

  const selectChat = useCallback(async (id) => {
    if (useStore.getState().isStreaming) return
    setCurrentChatId(id)
    const cached = useStore.getState().messagesByChat[id]
    if (cached) {
      setMessages(cached)
      return
    }
    try {
      const { messages: ms } = await adapter.loadChat(id)
      setMessagesForChat(id, ms ?? [])
    } catch (e) { setError(e.message) }
  }, [])

  const newChat = useCallback(async () => {
    try {
      const chat = await adapter.createChat('New Chat', useStore.getState().selectedModel)
      const cs = await adapter.listChats()
      setChats(cs)
      setCurrentChatId(chat.id)
      setMessages([])
      return chat
    } catch (e) { setError(e.message) }
  }, [])

  const startGeneration = useCallback((chatId, content, model) => {
    if (!chatId || !content.trim()) return
    appendMessage({ id: `u${Date.now()}`, chatId, role: 'user', content })
    setIsStreaming(true)
    setStreamingContent('')
    startStreamMetrics()

    const ctrl = adapter.sendMessage(
      chatId, content, model,
      (tok) => appendStreamingContent(tok),
      async (result) => {
        if (result?.aborted) return
        const finalState = useStore.getState()
        appendMessage({ id: `a${Date.now()}`, chatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics })
        setStreamingContent('')
        setStreamController(null)
        clearStreamMetrics()
        const cs = await adapter.listChats()
        setChats(cs)
        const next = shiftQueuedMessage()
        if (next) {
          startGeneration(next.chatId, next.content, next.model || useStore.getState().selectedModel)
        } else {
          setIsStreaming(false)
        }
      },
      (err) => {
        setIsStreaming(false)
        setStreamingContent('')
        setStreamController(null)
        clearStreamMetrics()
        setError(err.message)
      }
    )
    setStreamController(ctrl)
  }, [])

  const sendMessage = useCallback(async () => {
    const state = useStore.getState()
    if (!state.input.trim() || !state.currentChatId) return
    const content = state.input.trim()
    setInput('')
    if (state.isStreaming) {
      enqueueMessage({ chatId: state.currentChatId, content, model: state.selectedModel })
      return
    }
    startGeneration(state.currentChatId, content, state.selectedModel)
  }, [startGeneration])

  const stopGeneration = useCallback(() => {
    const { streamController: ctrl, streamingContent: content, streamMetrics: metrics, currentChatId: chatId } = useStore.getState()
    adapter.stopGeneration(ctrl)
    if (content.trim()) appendMessage({ id: `a${Date.now()}`, chatId, role: 'assistant', content, metrics })
    setStreamingContent('')
    setIsStreaming(false)
    setStreamController(null)
    clearStreamMetrics()
  }, [])

  const regenerate = useCallback(async () => {
    const state = useStore.getState()
    if (state.isStreaming || !state.currentChatId) return
    const msgs = state.messages
    const lastAIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'assistant')?.i
    if (lastAIdx != null) setMessages(msgs.slice(0, lastAIdx))

    setIsStreaming(true)
    setStreamingContent('')
    startStreamMetrics()
    const ctrl = adapter.regenerate(
      state.currentChatId, state.selectedModel,
      (tok) => appendStreamingContent(tok),
      () => {
        const finalState = useStore.getState()
        appendMessage({ id: `a${Date.now()}`, chatId: state.currentChatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics })
        setStreamingContent('')
        setIsStreaming(false)
        setStreamController(null)
        clearStreamMetrics()
      },
      (err) => {
        setIsStreaming(false)
        setStreamingContent('')
        setStreamController(null)
        clearStreamMetrics()
        setError(err.message)
      }
    )
    setStreamController(ctrl)
  }, [])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  return {
    models, selectedModel, setSelectedModel,
    chats, currentChatId,
    messages, streamingContent, isStreaming,
    streamMetrics, queuedMessages,
    input, setInput,
    loadModels, loadChats, selectChat, newChat,
    sendMessage, stopGeneration, regenerate, handleKeyDown,
  }
}
