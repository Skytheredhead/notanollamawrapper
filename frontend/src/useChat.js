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
    timers, stopwatches, streamToolCards, addStreamToolCard, clearStreamToolCards, applyClientToolAction,
    setError,
  } = useStore()

  const toolPayload = () => ({
    enabled: true,
    state: {
      timers: useStore.getState().timers,
      stopwatches: useStore.getState().stopwatches,
    },
  })

  const fallbackToolDisplay = (event) => ({
    title: event.name || event.event || 'Tool',
    summary: event.message || event.source || event.skipped || 'Working',
  })

  const toolEventToCard = (event) => {
    if (event.event === 'web_search') {
      return {
        toolCallId: event.toolCallId || `web_search_${Date.now()}`,
        name: 'web_search',
        toolName: 'web_search',
        status: event.used ? 'complete' : 'skipped',
        startedAt: event.startedAt || null,
        completedAt: Date.now(),
        elapsedMs: event.elapsedMs,
        cacheHit: event.cacheHit,
        source: event.provider ? `Local ${event.provider} search` : 'Local web search',
        display: event.display || {
          title: 'Web Search',
          summary: event.message || event.skipped || `${event.resultCount || 0} results`,
        },
      }
    }
    if (event.event === 'tool_call_start') {
      return {
        toolCallId: event.toolCallId,
        name: event.name,
        toolName: event.name,
        status: 'running',
        startedAt: event.startedAt || Date.now(),
        argsPreview: event.argsPreview || '',
        display: event.display || fallbackToolDisplay(event),
      }
    }
    if (event.event === 'tool_call_result') {
      return {
        toolCallId: event.toolCallId,
        name: event.name,
        toolName: event.name,
        status: 'complete',
        completedAt: Date.now(),
        elapsedMs: event.elapsedMs,
        cacheHit: event.cacheHit,
        source: event.source,
        display: event.display || fallbackToolDisplay(event),
      }
    }
    if (event.event === 'tool_call_error') {
      return {
        toolCallId: event.toolCallId,
        name: event.name,
        toolName: event.name,
        status: 'error',
        completedAt: Date.now(),
        elapsedMs: event.elapsedMs,
        error: event.message,
        display: event.display || fallbackToolDisplay(event),
      }
    }
    if (event.event === 'client_tool_action' && event.action) {
      return {
        ...event.action,
        toolCallId: event.toolCallId,
        name: event.name,
        toolName: event.name,
        action: event.action.action,
      }
    }
    return null
  }

  const handleToolEvent = (event) => {
    const card = toolEventToCard(event)
    if (card) addStreamToolCard(card)
    if (event.event === 'client_tool_action' && event.action) {
      const action = { ...event.action, toolCallId: event.toolCallId, toolName: event.name }
      applyClientToolAction(action)
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
    clearStreamToolCards()
    startStreamMetrics()

    const ctrl = adapter.sendMessage(
      chatId, content, model, options, webSearch,
      requestedAttachments,
      (tok) => appendStreamingContent(tok),
      async (result) => {
        if (result?.aborted) return
        const finalState = useStore.getState()
        appendMessage(result?.message
          ? { ...result.message, metrics: result.message.metrics || result.message.metadata?.metrics || finalState.streamMetrics, toolCards: finalState.streamToolCards }
          : { id: `a${Date.now()}`, chatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics, toolCards: finalState.streamToolCards })
        setStreamingContent('')
        setStreamController(null)
        clearStreamToolCards()
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
        clearStreamToolCards()
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
    const { streamController: ctrl, streamingContent: content, streamMetrics: metrics, streamToolCards: cards, currentChatId: chatId } = useStore.getState()
    adapter.stopGeneration(ctrl)
    if (content.trim()) appendMessage({ id: `a${Date.now()}`, chatId, role: 'assistant', content, metrics, toolCards: cards })
    setStreamingContent('')
    setIsStreaming(false)
    setStreamController(null)
    clearStreamToolCards()
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
    clearStreamToolCards()
    startStreamMetrics()
    const ctrl = adapter.regenerate(
      state.currentChatId, state.selectedModel, { num_ctx: state.contextSize }, state.webSearchEnabled,
      (tok) => appendStreamingContent(tok),
      (result) => {
        const finalState = useStore.getState()
        appendMessage(result?.message
          ? { ...result.message, metrics: result.message.metrics || result.message.metadata?.metrics || finalState.streamMetrics, toolCards: finalState.streamToolCards }
          : { id: `a${Date.now()}`, chatId: state.currentChatId, role: 'assistant', content: finalState.streamingContent, metrics: finalState.streamMetrics, toolCards: finalState.streamToolCards })
        setStreamingContent('')
        setIsStreaming(false)
        setStreamController(null)
        clearStreamToolCards()
        clearStreamMetrics()
        adapter.loadChat(state.currentChatId)
          .then(({ messages: ms }) => setMessagesForChat(state.currentChatId, ms ?? []))
          .catch(() => {})
      },
      (err) => {
        setIsStreaming(false)
        setStreamingContent('')
        setStreamController(null)
        clearStreamToolCards()
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
    streamMetrics, streamToolCards, queuedMessages,
    input, setInput,
    loadModels, loadChats, selectChat, newChat, unloadModels,
    sendMessage, stopGeneration, regenerate, handleKeyDown,
  }
}
