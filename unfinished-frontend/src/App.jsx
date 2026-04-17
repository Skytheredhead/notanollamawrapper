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

function orderChats(chats) {
  return [...chats].sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0))
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

function Settings({ models, selectedModel, setSelectedModel }) {
  const [open, setOpen] = useState(false)
  const [renderPanel, setRenderPanel] = useState(false)
  const [closing, setClosing] = useState(false)
  const wrapRef = useRef(null)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const colorMode = useStore((s) => s.colorMode)
  const setColorMode = useStore((s) => s.setColorMode)
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

function ChatCard({ active, messages, streamingContent, streamMetrics, isStreaming, now }) {
  const bottomRef = useRef(null)
  useEffect(() => {
    if (active) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [active, messages.length, streamingContent])

  return (
    <article className={`chatCard ${active ? 'isActive' : ''}`}>
      <div className="messageList">
        {messages.length === 0 && !streamingContent && (
          <div className="emptyState">
            <strong>Start clean.</strong>
            <span>One thought at a time.</span>
          </div>
        )}
        {messages.map((message) => (
          <section key={message.id} className={`message ${message.role}`}>
            <div className="messageRole">{message.role === 'user' ? 'You' : 'naow'}</div>
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
  const {
    models, selectedModel, setSelectedModel,
    chats, currentChatId, messages, streamingContent, isStreaming, streamMetrics,
    input, setInput, loadModels, loadChats, selectChat, newChat, sendMessage, stopGeneration, handleKeyDown,
  } = useChat()
  const messagesByChat = useStore((s) => s.messagesByChat)
  const [drag, setDrag] = useState({ active: false, startX: 0, dx: 0 })
  const [wheelDrag, setWheelDrag] = useState({ active: false, dx: 0 })
  const [now, setNow] = useState(() => performance.now())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const inputRef = useRef(null)
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

  const moveTo = (index) => {
    const next = orderedChats[Math.max(0, Math.min(orderedChats.length - 1, index))]
    if (next && next.id !== currentChatId) selectChat(next.id)
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
    const threshold = Math.min(180, Math.max(86, window.innerWidth * 0.16))
    if (drag.dx > threshold) moveTo(currentIndex - 1)
    if (drag.dx < -threshold) moveTo(currentIndex + 1)
    setDrag({ active: false, startX: 0, dx: 0 })
  }

  const settleWheel = (dx) => {
    const threshold = Math.min(180, Math.max(92, window.innerWidth * 0.16))
    if (dx > threshold) moveTo(currentIndex - 1)
    if (dx < -threshold) moveTo(currentIndex + 1)
    setWheelDrag({ active: false, dx: 0 })
  }

  const handleWheel = (event) => {
    if (Math.abs(event.deltaX) < Math.abs(event.deltaY) || Math.abs(event.deltaX) < 4) return
    event.preventDefault()

    setWheelDrag((previous) => {
      const maxPull = Math.min(360, Math.max(180, window.innerWidth * 0.34))
      let nextDx = previous.dx - event.deltaX * 1.25
      const atStart = currentIndex === 0 && nextDx > 0
      const atEnd = currentIndex === orderedChats.length - 1 && nextDx < 0
      if (atStart || atEnd) nextDx = previous.dx - event.deltaX * 0.32
      nextDx = Math.max(-maxPull, Math.min(maxPull, nextDx))

      window.clearTimeout(wheelSettleRef.current)
      wheelSettleRef.current = window.setTimeout(() => settleWheel(nextDx), 150)
      return { active: true, dx: nextDx }
    })
  }

  const resolvedColorMode = colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode

  return (
    <div className={`app theme-${theme} color-${resolvedColorMode}`}>
      <header className="topBar">
        <div className="leftCluster">
          <div className="brandButton">naow</div>
          <SearchBox chats={orderedChats} onSelect={selectChat} />
        </div>
        <Settings models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} />
      </header>

      <main className="stage">
        <div
          className={`carousel ${drag.active || wheelDrag.active ? 'isDragging' : ''}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            setDrag({ active: true, startX: e.clientX, dx: 0 })
          }}
          onPointerMove={(e) => {
            if (!drag.active) return
            const raw = e.clientX - drag.startX
            const atStart = currentIndex === 0 && raw > 0
            const atEnd = currentIndex === orderedChats.length - 1 && raw < 0
            const resistance = atStart || atEnd ? 0.28 : 1
            setDrag((s) => ({ ...s, dx: raw * resistance }))
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={handleWheel}
        >
          {orderedChats.map((chat, index) => {
            const offset = index - currentIndex
            const interactionDx = drag.active ? drag.dx : wheelDrag.dx
            const progress = interactionDx / Math.max(window.innerWidth * 0.62, 520)
            const wheelOffset = offset + progress
            const dragPx = interactionDx
            const rotate = wheelOffset * 8
            const scale = 1 - Math.min(Math.abs(wheelOffset) * 0.055, 0.11)
            return (
              <div
                key={chat.id}
                className="carouselSlide"
                style={{
                  transform: `translate3d(calc(${offset * 112}% - ${offset * 12}px + ${dragPx}px), 0, ${-Math.abs(wheelOffset) * 130}px) rotateY(${rotate}deg) scale(${scale})`,
                  opacity: Math.abs(offset) > 2 ? 0 : 1,
                  pointerEvents: index === currentIndex ? 'auto' : 'none',
                  zIndex: 10 - Math.abs(offset),
                }}
              >
                <ChatCard
                  active={index === currentIndex}
                  messages={chat.id === currentChatId ? messages : (messagesByChat[chat.id] || [])}
                  streamingContent={streamingContent}
                  streamMetrics={streamMetrics}
                  isStreaming={isStreaming}
                  now={now}
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
        <div className="composerShell">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={isStreaming || !currentChat} placeholder="Message naow" rows={1} onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 138)}px` }} />
          <div className="composerActions">
            <button className="sendButton" onClick={isStreaming ? stopGeneration : sendMessage}>{isStreaming ? 'Stop' : 'Send'}</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
