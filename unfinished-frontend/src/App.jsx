import React, { useEffect, useMemo, useRef, useState } from 'react'
import adapter from './adapter'
import MessageContent from './components/MessageContent'
import useStore from './store'
import { useChat } from './useChat'

const THEMES = [
  ['minimal', 'Minimal'],
  ['windows', 'Windows Classic'],
  ['comic', 'Comic Book'],
  ['terminal', 'Terminal'],
]

const COLOR_MODES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

const EMPTY_PROMPTS = [
  ['Start clean.', 'One thought at a time.'],
  ['What are we making?', 'Drop the first piece here.'],
  ['Quiet thread.', 'Ask something small or strange.'],
  ['Fresh page.', 'No context yet.'],
  ['Ready when you are.', 'Start anywhere.'],
]

function orderChats(chats) {
  return [...chats].sort((a, b) => new Date(a.createdAt || a.updatedAt || 0) - new Date(b.createdAt || b.updatedAt || 0))
}

function promptForChat(chatId, name) {
  const source = chatId || 'new'
  const sum = [...source].reduce((total, char) => total + char.charCodeAt(0), 0)
  const [title, subtitle] = EMPTY_PROMPTS[sum % EMPTY_PROMPTS.length]
  if (!name) return { title, subtitle }
  if (title === 'Ready when you are.') return { title: `Ready when you are, ${name}.`, subtitle }
  if (title === 'What are we making?') return { title: `What are we making, ${name}?`, subtitle }
  return { title, subtitle: `${subtitle} ${name ? `Your move, ${name}.` : ''}`.trim() }
}

function formatMetric(ms) {
  if (!Number.isFinite(ms)) return '--'
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`
}

function metricsText(metrics, now, streaming = false) {
  if (!metrics) return ''
  const end = streaming ? now : (metrics.updatedAt || now)
  const elapsed = Math.max((end - metrics.startedAt) / 1000, 0.001)
  const rate = metrics.tokens ? (metrics.tokens / elapsed).toFixed(1) : '--'
  const ttft = metrics.firstTokenAt ? formatMetric(metrics.firstTokenAt - metrics.startedAt) : 'waiting'
  return `${rate} tok/s · first token ${ttft}`
}

function MessageMetrics({ metrics, now, streaming }) {
  const showMetrics = useStore((s) => s.showMetrics)
  if (!showMetrics || !metrics) return null
  return <div className="messageMetrics">{metricsText(metrics, now, streaming)}</div>
}

function SearchBox({ chats, onSelect }) {
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState([])

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function hydrateSearchIndex() {
      const state = useStore.getState()
      const rows = await Promise.all(chats.map(async (chat) => {
        const cached = state.messagesByChat[chat.id]
        if (cached) return { chat, messages: cached }
        try {
          const data = await adapter.loadChat(chat.id)
          if (!cancelled) useStore.getState().setMessagesForChat(chat.id, data.messages || [])
          return { chat, messages: data.messages || [] }
        } catch {
          return { chat, messages: [] }
        }
      }))
      if (!cancelled) setIndex(rows)
    }
    hydrateSearchIndex()
    return () => { cancelled = true }
  }, [chats])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return index.flatMap(({ chat, messages }) => {
      const matches = []
      if (chat.title?.toLowerCase().includes(needle)) matches.push({ chat, preview: chat.title })
      for (const message of messages) {
        const content = message.content || ''
        const at = content.toLowerCase().indexOf(needle)
        if (at >= 0) {
          const preview = content.slice(Math.max(0, at - 36), at + needle.length + 58)
          matches.push({ chat, preview })
        }
      }
      return matches.slice(0, 3)
    }).slice(0, 8)
  }, [index, query])

  return (
    <div className="searchWrap">
      <input ref={inputRef} className="searchInput" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" />
      {results.length > 0 && (
        <div className="searchResults">
          {results.map((result, i) => (
            <button key={`${result.chat.id}-${i}`} onClick={() => { onSelect(result.chat.id); setQuery('') }}>
              <span>{result.chat.title}</span>
              <small>{result.preview}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SelectControl({ label, value, onChange, options }) {
  return (
    <label className="settingsField">
      <span>{label}</span>
      <span className="selectShell">
        <select value={value} onChange={onChange}>
          {options.map(([optionValue, labelText]) => <option key={optionValue} value={optionValue}>{labelText}</option>)}
        </select>
      </span>
    </label>
  )
}

function TextControl({ label, value, onChange, placeholder }) {
  return (
    <label className="settingsField">
      <span>{label}</span>
      <input className="settingsTextInput" value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  )
}

function Settings({ models, selectedModel, setSelectedModel }) {
  const [open, setOpen] = useState(false)
  const [renderPanel, setRenderPanel] = useState(false)
  const [closing, setClosing] = useState(false)
  const wrapRef = useRef(null)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const colorMode = useStore((s) => s.colorMode)
  const setColorMode = useStore((s) => s.setColorMode)
  const userName = useStore((s) => s.userName)
  const setUserName = useStore((s) => s.setUserName)
  const showMetrics = useStore((s) => s.showMetrics)
  const setShowMetrics = useStore((s) => s.setShowMetrics)
  const modelOptions = models.map((model) => [model, model])

  useEffect(() => {
    if (open) {
      setRenderPanel(true)
      requestAnimationFrame(() => setClosing(false))
      return
    }
    if (!renderPanel) return
    setClosing(true)
    const timeout = setTimeout(() => setRenderPanel(false), 180)
    return () => clearTimeout(timeout)
  }, [open, renderPanel])

  useEffect(() => {
    if (!open) return
    const closeIfOutside = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnTypingOutside = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeIfOutside, true)
    document.addEventListener('keydown', closeOnTypingOutside, true)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true)
      document.removeEventListener('keydown', closeOnTypingOutside, true)
    }
  }, [open])

  return (
    <div className="settingsWrap" ref={wrapRef}>
      <button className="iconButton" onClick={() => setOpen((v) => !v)} aria-label="Settings">Settings</button>
      {renderPanel && (
        <section className={`settingsPanel ${closing ? 'isClosing' : ''}`}>
          <div className="settingsTitle">Settings</div>
          <SelectControl label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)} options={THEMES} />
          <SelectControl label="Appearance" value={colorMode} onChange={(e) => setColorMode(e.target.value)} options={COLOR_MODES} />
          <TextControl label="Name" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your name" />
          <SelectControl label="Model" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} options={modelOptions} />
          <label className="checkRow">
            <input type="checkbox" checked={showMetrics} onChange={(e) => setShowMetrics(e.target.checked)} />
            <span className="customCheck" aria-hidden="true" />
            <span>Show token timing</span>
          </label>
        </section>
      )}
    </div>
  )
}

function ChatCard({ chatId, active, messages, streamingContent, streamMetrics, isStreaming, now, userName }) {
  const bottomRef = useRef(null)
  const emptyPrompt = promptForChat(chatId, userName)
  useEffect(() => {
    if (active) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [active, messages.length, streamingContent])

  return (
    <article className={`chatCard ${active ? 'isActive' : ''}`}>
      <div className="messageList">
        {messages.length === 0 && !streamingContent && (
          <div className="emptyState">
            <strong>{emptyPrompt.title}</strong>
            <span>{emptyPrompt.subtitle}</span>
          </div>
        )}
        {messages.map((message) => (
          <section key={message.id} className={`message ${message.role}`}>
            <div className="messageRole">{message.role === 'user' ? (userName || 'You') : 'naow'}</div>
            <MessageContent content={message.content} />
            {message.role === 'assistant' && <MessageMetrics metrics={message.metrics} now={now} />}
          </section>
        ))}
        {active && isStreaming && (
          <section className="message assistant isStreaming">
            <div className="messageRole">naow</div>
            <MessageContent content={streamingContent || ' '} />
            <MessageMetrics metrics={streamMetrics} now={now} streaming />
          </section>
        )}
        <div ref={bottomRef} />
      </div>
    </article>
  )
}

export default function App() {
  const theme = useStore((s) => s.theme)
  const colorMode = useStore((s) => s.colorMode)
  const userName = useStore((s) => s.userName).trim()
  const {
    models, selectedModel, setSelectedModel,
    chats, currentChatId, messages, streamingContent, isStreaming, streamMetrics, queuedMessages,
    input, setInput, loadModels, loadChats, selectChat, newChat, sendMessage, stopGeneration, handleKeyDown,
  } = useChat()
  const messagesByChat = useStore((s) => s.messagesByChat)
  const [drag, setDrag] = useState({ active: false, startX: 0, dx: 0 })
  const [wheelActive, setWheelActive] = useState(false)
  const [visualIndex, setVisualIndex] = useState(0)
  const [now, setNow] = useState(() => performance.now())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const inputRef = useRef(null)
  const dragRef = useRef(drag)
  const visualIndexRef = useRef(visualIndex)
  const wheelSettleRef = useRef(null)

  useEffect(() => {
    loadModels()
    loadChats().then((loaded) => {
      const ordered = orderChats(loaded)
      if (!ordered.length) newChat()
      else if (!useStore.getState().currentChatId) selectChat(ordered[ordered.length - 1].id)
    })
  }, [])

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(performance.now()), 120)
    return () => clearInterval(timer)
  }, [isStreaming])

  useEffect(() => { inputRef.current?.focus() }, [currentChatId])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (event) => setSystemDark(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => () => window.clearTimeout(wheelSettleRef.current), [])

  const orderedChats = useMemo(() => orderChats(chats), [chats])
  const currentIndex = Math.max(0, orderedChats.findIndex((chat) => chat.id === currentChatId))
  const currentChat = orderedChats[currentIndex]
  const maxIndex = Math.max(0, orderedChats.length - 1)

  const setVisualPosition = (position) => {
    visualIndexRef.current = position
    setVisualIndex(position)
  }

  const setDragState = (next) => {
    dragRef.current = next
    setDrag(next)
  }

  useEffect(() => {
    if (!drag.active && !wheelActive) setVisualPosition(currentIndex)
  }, [currentIndex, drag.active, wheelActive])

  const moveTo = (index) => {
    const next = orderedChats[Math.max(0, Math.min(orderedChats.length - 1, index))]
    if (next && next.id !== currentChatId) selectChat(next.id)
  }

  const settleTo = (index) => {
    const target = Math.max(0, Math.min(maxIndex, index))
    setVisualPosition(target)
    moveTo(target)
  }

  const openNewThread = () => {
    if (isStreaming) return
    if (currentChat && messages.length === 0) {
      inputRef.current?.focus()
      return
    }

    const reusable = orderedChats.find((chat) => {
      if (chat.id === currentChatId) return false
      const cachedMessages = messagesByChat[chat.id]
      const knownEmpty = chat.messageCount === 0 || cachedMessages?.length === 0
      const looksUntitled = !chat.title || /^new chat$/i.test(chat.title)
      return knownEmpty && looksUntitled
    })

    if (reusable) {
      selectChat(reusable.id)
      return
    }

    newChat()
  }

  const endDrag = () => {
    const lastDrag = dragRef.current
    const threshold = Math.min(180, Math.max(86, window.innerWidth * 0.16))
    let target = currentIndex
    if (lastDrag.dx > threshold) target = currentIndex - 1
    if (lastDrag.dx < -threshold) target = currentIndex + 1
    setDragState({ active: false, startX: 0, dx: 0 })
    settleTo(target)
  }

  const settleWheel = (position) => {
    const target = Math.round(Math.max(0, Math.min(maxIndex, position)))
    setWheelActive(false)
    settleTo(target)
  }

  const handleWheel = (event) => {
    if (Math.abs(event.deltaX) < Math.abs(event.deltaY) || Math.abs(event.deltaX) < 4) return
    event.preventDefault()

    const currentVisual = visualIndexRef.current
    const pageWidth = Math.max(window.innerWidth * 0.62, 520)
    const edgeResistance =
      (currentVisual <= 0 && event.deltaX < 0) || (currentVisual >= maxIndex && event.deltaX > 0)
        ? 0.22
        : 1
    const nextPosition = Math.max(-0.16, Math.min(maxIndex + 0.16, currentVisual + (event.deltaX * edgeResistance) / pageWidth))

    setWheelActive(true)
    setVisualPosition(nextPosition)
    window.clearTimeout(wheelSettleRef.current)
    wheelSettleRef.current = window.setTimeout(() => settleWheel(visualIndexRef.current), 140)
  }

  const resolvedColorMode = colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode
  const currentQueue = queuedMessages.filter((message) => message.chatId === currentChatId)
  const actionLabel = isStreaming ? (input.trim() ? 'Queue' : 'Stop') : 'Send'
  const handleComposerAction = () => {
    if (isStreaming && !input.trim()) stopGeneration()
    else sendMessage()
  }

  return (
    <div className={`app theme-${theme} color-${resolvedColorMode}`}>
      <div className="themeFade" aria-hidden="true" />
      <header className="topBar">
        <div className="leftCluster">
          <button className="brandButton" onClick={openNewThread}>naow</button>
          <SearchBox chats={orderedChats} onSelect={selectChat} />
        </div>
        <Settings models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} />
      </header>

      <main className="stage">
        <div
          className={`carousel ${drag.active || wheelActive ? 'isDragging' : ''}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            setDragState({ active: true, startX: e.clientX, dx: 0 })
          }}
          onPointerMove={(e) => {
            const lastDrag = dragRef.current
            if (!lastDrag.active) return
            const raw = e.clientX - lastDrag.startX
            const atStart = currentIndex === 0 && raw > 0
            const atEnd = currentIndex === orderedChats.length - 1 && raw < 0
            const resistance = atStart || atEnd ? 0.28 : 1
            const dx = raw * resistance
            setDragState({ ...lastDrag, dx })
            setVisualPosition(Math.max(-0.16, Math.min(maxIndex + 0.16, currentIndex - dx / Math.max(window.innerWidth * 0.62, 520))))
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={handleWheel}
        >
          {orderedChats.map((chat, index) => {
            const wheelOffset = index - visualIndex
            const rotate = wheelOffset * 8
            const scale = 1 - Math.min(Math.abs(wheelOffset) * 0.055, 0.11)
            return (
              <div
                key={chat.id}
                className="carouselSlide"
                style={{
                  transform: `translate3d(calc(${wheelOffset * 112}% - ${wheelOffset * 12}px), 0, ${-Math.abs(wheelOffset) * 130}px) rotateY(${rotate}deg) scale(${scale})`,
                  opacity: Math.abs(wheelOffset) > 2 ? 0 : 1,
                  pointerEvents: Math.round(visualIndex) === index ? 'auto' : 'none',
                  zIndex: 10 - Math.round(Math.abs(wheelOffset)),
                }}
              >
                <ChatCard
                  chatId={chat.id}
                  active={index === currentIndex}
                  messages={chat.id === currentChatId ? messages : (messagesByChat[chat.id] || [])}
                  streamingContent={streamingContent}
                  streamMetrics={streamMetrics}
                  isStreaming={isStreaming}
                  now={now}
                  userName={userName}
                />
              </div>
            )
          })}
        </div>
        <button className="newThreadButton" onClick={openNewThread} aria-label="New thread">
          <span>+</span>
        </button>
        {orderedChats.length > 1 && (
          <div className="chatDots">
            {orderedChats.map((chat, index) => (
              <button key={chat.id} className={index === currentIndex ? 'isCurrent' : ''} onClick={() => moveTo(index)} aria-label={`Open ${chat.title}`} />
            ))}
          </div>
        )}
      </main>

      <footer className="composer">
        {currentQueue.length > 0 && (
          <div className="queueShelf" aria-live="polite">
            <span className="queueLabel">{currentQueue.length === 1 ? 'Queued next' : `${currentQueue.length} queued`}</span>
            <div className="queueItems">
              {currentQueue.slice(0, 3).map((message) => (
                <div className="queueChip" key={message.id}>{message.content}</div>
              ))}
              {currentQueue.length > 3 && <div className="queueChip more">+{currentQueue.length - 3}</div>}
            </div>
          </div>
        )}
        <div className="composerShell">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={!currentChat} placeholder={isStreaming ? 'Queue the next message' : (userName ? `Message naow, ${userName}` : 'Message naow')} rows={1} onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 138)}px` }} />
          <div className="composerActions">
            <button className="sendButton" onClick={handleComposerAction}>{actionLabel}</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
