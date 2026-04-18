import { useCallback } from 'react'
import adapter from './adapter'
import useStore from './store'

export function useChat() {
  const {
    models, setModels,
    selectedModel, setSelectedModel,
    contextSize, webSearchEnabled, modelResidency,
    chats, setChats,
    currentChatId, setCurrentChatId,
    messages, setMessages, setMessagesForChat, appendMessage,
    streamingContent, setStreamingContent, appendStreamingContent,
    isStreaming, setIsStreaming,
    streamController, setStreamController,
    streamMetrics, startStreamMetrics, clearStreamMetrics,
    queuedMessages, enqueueMessage, shiftQueuedMessage,
    input, setInput,
    pendingAttachments, clearPendingAttachments,
    timers, stopwatches, addToolActivity, applyClientToolAction,
    setError,
  } = useStore()

  const toolPayload = () => ({
    enabled: true,
    state: {
      timers: useStore.getState().timers,
      stopwatches: useStore.getState().stopwatches,
    },
  })

  const handleToolEvent = (event) => {
    addToolActivity(event)
    if (event.event === 'client_tool_action' && event.action) {
      applyClientToolAction(event.action)
    }
  }

  const loadModels = useCallback(async () => {
    try {
      const ms = await adapter.listModels()
      setModels(ms)
      const current = useStore.getState().selectedModel
      if (ms.length > 0 && (!current || !ms.includes(current))) setSelectedModel(ms[0])
      return ms
    } catch (e) {
      setError(e.message)
      return []
    }
  }, [])

  const unloadModels = useCallback(async () => {
    try {
      return await adapter.unloadModels()
    } catch (e) {
      setError(e.message)
      throw e
    }
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

  const startGeneration = useCallback((chatId, content, model, requestedContextSize, requestedWebSearchEnabled, requestedAttachments = [], requestedTools = null) => {
    if (!chatId || (!content.trim() && requestedAttachments.length === 0)) return
    const options = { num_ctx: requestedContextSize || useStore.getState().contextSize }
    options.max_tokens = 1024
    options.residency = useStore.getState().modelResidency
    const webSearch = requestedWebSearchEnabled ?? useStore.getState().webSearchEnabled
    appendMessage({
      id: `u${Date.now()}`,
      chatId,
      role: 'user',
      content,
      attachments: requestedAttachments.map((attachment) => ({
        id: attachment.id,
        type: 'image',
        mimeType: attachment.mimeType,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        url: URL.createObjectURL(attachment.file),
      })),
    })
    setIsStreaming(true)
    setStreamingContent('')
    startStreamMetrics()

    const ctrl = adapter.sendMessage(
      chatId, content, model, options, webSearch,
      requestedAttachments,
      (tok) => appendStreamingContent(tok),
      async (result) => {
        if (result?.aborted) return
        const finalState = useStore.getState()
        appendMessage(result?.message
          ? { ...result.message, metrics: result.message.metrics || result.message.metadata?.metrics || finalState.streamMetrics }
          : { id: `a${Date.now()}`, chatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics })
        setStreamingContent('')
        setStreamController(null)
        clearStreamMetrics()
        const cs = await adapter.listChats()
        setChats(cs)
        await adapter.loadChat(chatId)
          .then(({ messages: ms }) => setMessagesForChat(chatId, ms ?? []))
          .catch(() => {})
        const next = shiftQueuedMessage()
        if (next) {
          startGeneration(
            next.chatId,
            next.content,
            next.model || useStore.getState().selectedModel,
            next.contextSize || useStore.getState().contextSize,
            next.webSearchEnabled ?? useStore.getState().webSearchEnabled,
            next.attachments || [],
            next.tools || toolPayload()
          )
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
        appendMessage({
          id: `err${Date.now()}`,
          chatId,
          role: 'assistant',
          content: err.message || 'Generation failed',
          status: 'error',
          error: err.message || 'Generation failed',
        })
        adapter.loadChat(chatId)
          .then(({ messages: ms }) => setMessagesForChat(chatId, ms ?? []))
          .catch(() => {})
      },
      requestedTools || toolPayload(),
      handleToolEvent
    )
    setStreamController(ctrl)
  }, [])

  const sendMessage = useCallback(async () => {
    const state = useStore.getState()
    if ((!state.input.trim() && state.pendingAttachments.length === 0) || !state.currentChatId) return
    const content = state.input.trim()
    const attachments = state.pendingAttachments
    setInput('')
    clearPendingAttachments()
    if (state.isStreaming) {
      enqueueMessage({ chatId: state.currentChatId, content, model: state.selectedModel, contextSize: state.contextSize, webSearchEnabled: state.webSearchEnabled, tools: toolPayload(), attachments })
      return
    }
    startGeneration(state.currentChatId, content, state.selectedModel, state.contextSize, state.webSearchEnabled, attachments, toolPayload())
  }, [startGeneration])

  const stopGeneration = useCallback(() => {
    const { streamController: ctrl, streamingContent: content, streamMetrics: metrics, currentChatId: chatId } = useStore.getState()
    adapter.stopGeneration(ctrl)
    if (content.trim()) appendMessage({ id: `a${Date.now()}`, chatId, role: 'assistant', content, metrics })
    setStreamingContent('')
    setIsStreaming(false)
    setStreamController(null)
    clearStreamMetrics()
    window.setTimeout(() => {
      if (!chatId) return
      adapter.loadChat(chatId)
        .then(({ messages: ms }) => setMessagesForChat(chatId, ms ?? []))
        .catch(() => {})
    }, 250)
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
      state.currentChatId, state.selectedModel, { num_ctx: state.contextSize }, state.webSearchEnabled,
      (tok) => appendStreamingContent(tok),
      (result) => {
        const finalState = useStore.getState()
        appendMessage(result?.message
          ? { ...result.message, metrics: result.message.metrics || result.message.metadata?.metrics || finalState.streamMetrics }
          : { id: `a${Date.now()}`, chatId: state.currentChatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics })
        setStreamingContent('')
        setIsStreaming(false)
        setStreamController(null)
        clearStreamMetrics()
        adapter.loadChat(state.currentChatId)
          .then(({ messages: ms }) => setMessagesForChat(state.currentChatId, ms ?? []))
          .catch(() => {})
      },
      (err) => {
        setIsStreaming(false)
        setStreamingContent('')
        setStreamController(null)
        clearStreamMetrics()
        setError(err.message)
        appendMessage({
          id: `err${Date.now()}`,
          chatId: state.currentChatId,
          role: 'assistant',
          content: err.message || 'Generation failed',
          status: 'error',
          error: err.message || 'Generation failed',
        })
        adapter.loadChat(state.currentChatId)
          .then(({ messages: ms }) => setMessagesForChat(state.currentChatId, ms ?? []))
          .catch(() => {})
      },
      toolPayload(),
      handleToolEvent
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
    models, selectedModel, setSelectedModel, contextSize, webSearchEnabled,
    modelResidency, pendingAttachments, timers, stopwatches,
    chats, currentChatId,
    messages, streamingContent, isStreaming,
    streamMetrics, queuedMessages,
    input, setInput,
    loadModels, loadChats, selectChat, newChat, unloadModels,
    sendMessage, stopGeneration, regenerate, handleKeyDown,
  }
}
