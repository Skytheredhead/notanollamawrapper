import { useCallback, useEffect, useRef } from 'react'
import adapter from './adapter'
import useStore from './store'

export function useChat() {
  const {
    models, setModels,
    selectedModel, setSelectedModel,
    contextSize, webSearchEnabled, searchStrategy, modelResidency,
    chats, setChats,
    currentChatId, setCurrentChatId,
    messages, setMessages, setMessagesForChat, appendMessage,
    streamingContent, setStreamingContent, appendStreamingContent,
    isStreaming, setIsStreaming,
    streamController, setStreamController,
    streamMetrics, streamSearchStatus, setStreamSearchStatus, startStreamMetrics, clearStreamMetrics,
    queuedMessages, enqueueMessage, shiftQueuedMessage,
    input, setInput,
    currentPreSearchId, setCurrentPreSearchId,
    pendingAttachments, clearPendingAttachments,
    timers, stopwatches, streamToolCards, addStreamToolCard, clearStreamToolCards, applyClientToolAction,
    setError,
  } = useStore()
  const preSearchAbortRef = useRef(null)

  useEffect(() => {
    const state = useStore.getState()
    const draft = state.input.trim()
    const tokenCount = draft ? draft.split(/\s+/).filter(Boolean).length : 0
    const secretLike = /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|bearer)\b/i.test(draft)
      || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(draft)
      || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(draft)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(draft)

    preSearchAbortRef.current?.abort?.()
    if (state.searchStrategy !== 'pre-search' || !state.webSearchEnabled || !state.currentChatId || tokenCount < 5 || state.pendingAttachments.length || secretLike) {
      setCurrentPreSearchId(null)
      return undefined
    }

    const ctrl = new AbortController()
    preSearchAbortRef.current = ctrl
    const timer = window.setTimeout(async () => {
      try {
        const result = await adapter.preSearchAnalyze?.(state.currentChatId, draft, {
          enabled: state.searchStrategy === 'pre-search',
          webSearch: state.webSearchEnabled,
          hasAttachments: state.pendingAttachments.length > 0,
          previousPreSearchId: state.currentPreSearchId,
        }, ctrl.signal)
        if (!ctrl.signal.aborted) {
          setCurrentPreSearchId(result?.used ? result.preSearchId : null)
        }
      } catch {
        if (!ctrl.signal.aborted) setCurrentPreSearchId(null)
      }
    }, 650)

    return () => {
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [input, currentChatId, searchStrategy, webSearchEnabled, pendingAttachments.length])

  const toolPayload = () => ({
    enabled: true,
    state: {
      timers: useStore.getState().timers,
      stopwatches: useStore.getState().stopwatches,
      calculators: useStore.getState().calculators,
    },
  })

  const fallbackToolDisplay = (event) => ({
    title: event.name || event.event || 'Tool',
    summary: event.message || event.source || event.skipped || 'Working',
  })

  const toolEventToCard = (event) => {
    if (event.event === 'web_search') {
      return null
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
    if (event.event === 'generation_start') {
      setStreamSearchStatus(null)
      return
    }
    if (event.event === 'search_status') {
      setStreamSearchStatus(
        event.phase === 'searching' || event.phase === 'finding_weather' ? event : null
      )
      return
    }
    const card = toolEventToCard(event)
    if (card) addStreamToolCard(card)
    if (event.event === 'tool_call_result' && event.name === 'calculate' && event.display?.calculator) {
      useStore.getState().upsertCalculator(event.toolCallId, event.display.calculator)
    }
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

  const selectChat = useCallback(async (idOrSlug) => {
    if (useStore.getState().isStreaming) return
    const raw = String(idOrSlug ?? '').trim()
    if (!raw) return
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    const chatList = useStore.getState().chats
    const fromList = looksLikeUuid
      ? chatList.find((c) => c.id === raw)
      : chatList.find((c) => c.slug === raw || c.id === raw)
    const resolvedId = fromList?.id || (looksLikeUuid ? raw : null)

    if (looksLikeUuid && resolvedId) {
      const cached = useStore.getState().messagesByChat[resolvedId]
      if (cached) {
        setCurrentChatId(resolvedId)
        setMessages(cached)
        const slug = fromList?.slug
        if (slug && typeof window !== 'undefined') {
          const path = `/chat/${slug}`
          if (window.location.pathname !== path) {
            window.history.pushState({ naowChatSlug: slug }, '', path)
          }
        }
        return
      }
    }
    if (!looksLikeUuid && fromList?.id) {
      const cached = useStore.getState().messagesByChat[fromList.id]
      if (cached) {
        setCurrentChatId(fromList.id)
        setMessages(cached)
        if (fromList.slug && typeof window !== 'undefined') {
          const path = `/chat/${fromList.slug}`
          if (window.location.pathname !== path) {
            window.history.pushState({ naowChatSlug: fromList.slug }, '', path)
          }
        }
        return
      }
    }
    try {
      const data = await adapter.loadChat(raw)
      const chat = data.chat
      const ms = data.messages ?? []
      if (!chat?.id) return
      setCurrentChatId(chat.id)
      setMessagesForChat(chat.id, ms)
      const slug = chat.slug
      if (slug && typeof window !== 'undefined') {
        const path = `/chat/${slug}`
        if (window.location.pathname !== path) {
          window.history.pushState({ naowChatSlug: slug }, '', path)
        }
      }
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const newChat = useCallback(async () => {
    try {
      const chat = await adapter.createChat('New Chat', useStore.getState().selectedModel)
      const cs = await adapter.listChats()
      setChats(cs)
      setCurrentChatId(chat.id)
      setMessages([])
      if (chat?.slug && typeof window !== 'undefined') {
        window.history.replaceState({ naowChatSlug: chat.slug }, '', `/chat/${chat.slug}`)
      }
      return chat
    } catch (e) { setError(e.message) }
  }, [])

  const startGeneration = useCallback((chatId, content, model, requestedContextSize, requestedWebSearchEnabled, requestedAttachments = [], requestedTools = null, requestedPreSearchId = null, requestedSearchStrategy = null) => {
    if (!chatId || (!content.trim() && requestedAttachments.length === 0)) return
    const options = { num_ctx: requestedContextSize || useStore.getState().contextSize }
    options.max_tokens = 1024
    options.residency = useStore.getState().modelResidency
    const webSearch = requestedWebSearchEnabled ?? useStore.getState().webSearchEnabled
    const activeSearchStrategy = requestedSearchStrategy || useStore.getState().searchStrategy || 'normal'
    const preSearchId = activeSearchStrategy === 'pre-search'
      ? (requestedPreSearchId ?? useStore.getState().currentPreSearchId)
      : null
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
    setStreamSearchStatus(null)
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
            next.tools || toolPayload(),
            next.preSearchId || null,
            next.searchStrategy || useStore.getState().searchStrategy
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
      handleToolEvent,
      preSearchId,
      activeSearchStrategy
    )
    setStreamController(ctrl)
  }, [])

  const sendMessage = useCallback(async () => {
    const state = useStore.getState()
    if ((!state.input.trim() && state.pendingAttachments.length === 0) || !state.currentChatId) return
    const content = state.input.trim()
    const attachments = state.pendingAttachments
    const activeSearchStrategy = state.searchStrategy || 'normal'
    const preSearchId = activeSearchStrategy === 'pre-search' ? state.currentPreSearchId : null
    setInput('')
    setCurrentPreSearchId(null)
    clearPendingAttachments()
    if (state.isStreaming) {
      enqueueMessage({ chatId: state.currentChatId, content, model: state.selectedModel, contextSize: state.contextSize, webSearchEnabled: state.webSearchEnabled, tools: toolPayload(), attachments, preSearchId, searchStrategy: activeSearchStrategy })
      return
    }
    startGeneration(state.currentChatId, content, state.selectedModel, state.contextSize, state.webSearchEnabled, attachments, toolPayload(), preSearchId, activeSearchStrategy)
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

  const regenerate = useCallback(async (messageId = null, searchMode = 'normal') => {
    const state = useStore.getState()
    if (state.isStreaming || !state.currentChatId) return
    const msgs = state.messages
    let targetIndex = -1
    if (messageId) {
      const index = msgs.findIndex((message) => message.id === messageId)
      if (index >= 0 && msgs[index].role === 'assistant') targetIndex = index
      if (index >= 0 && msgs[index].role === 'user') {
        const nextAssistantOffset = msgs.slice(index + 1).findIndex((message) => message.role === 'assistant')
        targetIndex = nextAssistantOffset >= 0 ? index + 1 + nextAssistantOffset : -1
      }
    } else {
      targetIndex = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'assistant')?.i ?? -1
    }
    if (targetIndex >= 0) setMessages(msgs.slice(0, targetIndex))

    setIsStreaming(true)
    setStreamingContent('')
    clearStreamToolCards()
    setStreamSearchStatus(null)
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
      handleToolEvent,
      {
        messageId,
        searchMode,
        searchStrategy: state.searchStrategy || 'normal',
      }
    )
    setStreamController(ctrl)
  }, [])

  const editUserMessage = useCallback(async (messageId, nextContent) => {
    const state = useStore.getState()
    const content = String(nextContent || '').trim()
    if (state.isStreaming || !state.currentChatId || !messageId || !content) return
    const msgs = state.messages
    const targetIndex = msgs.findIndex((message) => message.id === messageId && message.role === 'user')
    if (targetIndex < 0) return

    setMessages([
      ...msgs.slice(0, targetIndex),
      {
        ...msgs[targetIndex],
        content,
        attachments: [],
      },
    ])
    setIsStreaming(true)
    setStreamingContent('')
    clearStreamToolCards()
    setStreamSearchStatus(null)
    startStreamMetrics()

    const ctrl = adapter.editMessage(
      state.currentChatId,
      messageId,
      content,
      state.selectedModel,
      { num_ctx: state.contextSize, max_tokens: 1024, residency: state.modelResidency },
      state.webSearchEnabled,
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
      handleToolEvent,
      {
        searchStrategy: state.searchStrategy || 'normal',
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
    models, selectedModel, setSelectedModel, contextSize, webSearchEnabled, searchStrategy,
    modelResidency, pendingAttachments, timers, stopwatches,
    chats, currentChatId,
    messages, streamingContent, isStreaming,
    streamMetrics, streamSearchStatus, streamToolCards, queuedMessages,
    input, setInput,
    loadModels, loadChats, selectChat, newChat, unloadModels,
    sendMessage, stopGeneration, regenerate, editUserMessage, handleKeyDown,
  }
}
