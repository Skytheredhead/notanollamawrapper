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

const CONTEXT_OPTIONS = [
  [4096, '4k'],
  [8192, '8k'],
  [16384, '16k'],
  [32768, '32k'],
  [65536, '64k'],
  [131072, '128k'],
]

const RESIDENCY_OPTIONS = [
  ['always_hot', 'Always hot'],
  ['warm_idle', 'Warm idle'],
  ['unload_after_reply', 'Unload after reply'],
]

const SEARCH_STRATEGY_OPTIONS = [
  ['normal', 'Normal'],
  ['pre-search', 'Pre-search'],
]

const EMPTY_PROMPTS = [
  ['Start clean.', 'One thought at a time.'],
  ['What are we making?', 'Drop the first piece here.'],
  ['Quiet thread.', 'Ask something small or strange.'],
  ['Fresh page.', 'No context yet.'],
  ['Ready when you are.', 'Start anywhere.'],
]

const STATS_REFRESH_MS = 650
const IDLE_STATS_REFRESH_MS = 5000
const INACTIVE_STATS_REFRESH_MS = 60000
const CPU_DISPLAY_REFRESH_MS = 2500

function orderChats(chats) {
  const isEmptyNew = (chat) => {
    const looksUntitled = !chat.title || /^new chat$/i.test(chat.title)
    return looksUntitled && chat.messageCount === 0
  }
  return [...chats].sort((a, b) => {
    const aEmpty = isEmptyNew(a)
    const bEmpty = isEmptyNew(b)
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1
    return new Date(a.createdAt || a.updatedAt || 0) - new Date(b.createdAt || b.updatedAt || 0)
  })
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

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!value) return '--'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number.toFixed(number > 0 && number < 10 ? 1 : 0)}%`
}

function formatDownloadPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number.toFixed(number > 0 && number < 99.95 ? 1 : 0)}%`
}

function formatDownloadRate(bytesPerSecond) {
  const value = Number(bytesPerSecond || 0)
  return value > 0 ? `${formatBytes(value)}/s` : '--'
}

function formatEta(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 60) return `${Math.round(value)}s left`
  const minutes = Math.floor(value / 60)
  const remainder = Math.round(value % 60)
  return `${minutes}m ${String(remainder).padStart(2, '0')}s left`
}

function downloadProgressText(status) {
  const pct = Math.max(0, Math.min(100, Number(status?.pct || 0)))
  const rateText = formatDownloadRate(status?.downloadRateBytesPerSec)
  const etaText = formatEta(status?.etaSeconds)
  return [
    formatDownloadPercent(pct),
    `${formatBytes(status?.downloadedBytes)} / ${formatBytes(status?.totalBytes)}`,
    rateText !== '--' ? rateText : '',
    etaText,
  ].filter(Boolean).join(' · ')
}

function metricsText(metrics, now, streaming = false) {
  if (!metrics) return ''
  if (Number.isFinite(metrics.generationMs)) {
    const rate = Number.isFinite(metrics.tokensPerSecond)
      ? metrics.tokensPerSecond.toFixed(metrics.tokensPerSecond > 0 && metrics.tokensPerSecond < 10 ? 1 : 0)
      : '--'
    const parts = [
      `${rate} tok/s`,
      `first token ${Number.isFinite(metrics.firstTokenMs) ? formatMetric(metrics.firstTokenMs) : 'waiting'}`,
    ]
    if (Number.isFinite(metrics.promptBuildMs) && metrics.promptBuildMs > 25) {
      parts.push(`prompt ${formatMetric(metrics.promptBuildMs)}`)
    }
    if (Number.isFinite(metrics.modelFirstTokenMs) && metrics.modelFirstTokenMs > 250) {
      parts.push(`prefill ${formatMetric(metrics.modelFirstTokenMs)}`)
    }
    if (Number(metrics.webSearchMs) > 0) parts.push(`search ${formatMetric(metrics.webSearchMs)}`)
    if (Number(metrics.webSearch?.classifierMs) > 250) parts.push(`gate ${formatMetric(metrics.webSearch.classifierMs)}`)
    parts.push(`total ${formatMetric(metrics.generationMs)}`)
    return parts.join(' · ')
  }
  const end = streaming ? now : (metrics.updatedAt || now)
  const elapsed = Math.max((end - metrics.startedAt) / 1000, 0.001)
  const rate = metrics.tokens ? (metrics.tokens / elapsed).toFixed(1) : '--'
  const ttft = metrics.firstTokenAt ? formatMetric(metrics.firstTokenAt - metrics.startedAt) : 'waiting'
  return `${rate} tok/s · first token ${ttft}`
}

function IconSources() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6.5h10" />
      <path d="M7 11.5h10" />
      <path d="M7 16.5h6" />
      <path d="M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z" />
    </svg>
  )
}

function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h10v10H8z" />
      <path d="M6 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.3 4.2L19 7" />
    </svg>
  )
}

function IconRegenerate() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.5 8.5A7 7 0 0 0 6 7.2" />
      <path d="M6 4.5v2.7h2.7" />
      <path d="M5.5 15.5A7 7 0 0 0 18 16.8" />
      <path d="M18 19.5v-2.7h-2.7" />
    </svg>
  )
}

function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 16.5-.5 4 4-.5L18.8 8.7l-3.5-3.5L4 16.5Z" />
      <path d="m13.8 6.7 3.5 3.5" />
    </svg>
  )
}

function IconX() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </svg>
  )
}

function MessageMetrics({ metrics, now, streaming }) {
  const showMetrics = useStore((s) => s.showMetrics)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [sourceDetails, setSourceDetails] = useState(null)
  const [loadingSources, setLoadingSources] = useState(false)
  if (!showMetrics || !metrics) return null
  const sources = Array.isArray(metrics.sources) ? metrics.sources.filter((source) => source?.url).slice(0, 10) : []
  const faviconForSource = (source) => {
    if (source.faviconUrl) return source.faviconUrl
    try {
      return `${new URL(source.url).origin}/favicon.ico`
    } catch {
      return ''
    }
  }
  const openSources = async () => {
    const nextOpen = !sourcesOpen
    setSourcesOpen(nextOpen)
    if (!nextOpen || sourceDetails || loadingSources || !sources.length) return
    setLoadingSources(true)
    try {
      const result = await adapter.summarizeSources?.(sources)
      setSourceDetails(result?.sources || sources)
    } catch {
      setSourceDetails(sources)
    } finally {
      setLoadingSources(false)
    }
  }
  return (
    <div className="messageMetrics">
      <span>{metricsText(metrics, now, streaming)}</span>
      {sources.length > 0 && (
        <span className="messageSourcesWrap">
          <span className="messageMetricActionSpacer" aria-hidden="true" />
          <button type="button" className="sourcesButton iconOnlyButton" onClick={openSources} aria-label="Sources" title="Sources">
            <IconSources />
          </button>
          {sourcesOpen && (
            <>
            <span className="sourcesPopoverBackdrop" onClick={() => setSourcesOpen(false)} aria-hidden="true" />
            <span className="sourcesPopover" role="dialog" aria-label="Sources">
              <span className="sourcesPopoverHeader">
                <strong>Sources</strong>
                <button type="button" onClick={() => setSourcesOpen(false)} aria-label="Close sources">×</button>
              </span>
              {loadingSources && <span className="sourcesLoading">Summarizing...</span>}
              {(sourceDetails || sources).map((source, index) => (
                <a className={`sourceResult ${index === 0 ? 'isPrimary' : ''}`} href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
                  {faviconForSource(source) && <img src={faviconForSource(source)} alt="" onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />}
                  <span>
                    <strong>{source.title || source.url}</strong>
                    <small>{source.domain || source.url}</small>
                    <em>{source.summary || source.snippet || 'No summary available.'}</em>
                  </span>
                </a>
              ))}
            </span>
            </>
          )}
        </span>
      )}
    </div>
  )
}

function MessageActions({ message, onRegenerate }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || message.error || '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  if (message.role !== 'assistant') return null
  const regenerate = (mode) => {
    setOpen(false)
    onRegenerate?.(message.id, mode)
  }
  return (
    <div className="messageActions">
      <button type="button" className="iconOnlyButton" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      <span className="regenerateWrap">
        <button type="button" className="iconOnlyButton" onClick={() => setOpen((value) => !value)} aria-label="Regenerate" title="Regenerate">
          <IconRegenerate />
        </button>
        {open && (
          <span className="regenerateMenu">
            <button type="button" onClick={() => regenerate('normal')}>Regenerate</button>
            <button type="button" onClick={() => regenerate('extra')}>Extra search</button>
          </span>
        )}
      </span>
    </div>
  )
}

function UserMessageBubble({ message, onEditUserMessage }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content || '')

  useEffect(() => {
    if (!editing) setDraft(message.content || '')
  }, [message.content, editing])

  const cancel = () => {
    setDraft(message.content || '')
    setEditing(false)
  }

  const submit = (event) => {
    event.preventDefault()
    const next = draft.trim()
    if (!next || next === (message.content || '').trim()) {
      cancel()
      return
    }
    setEditing(false)
    onEditUserMessage?.(message.id, next)
  }

  return (
    <>
      <AttachmentStrip attachments={message.attachments} />
      {editing ? (
        <form className="userEditForm" onSubmit={submit}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
          <span className="userEditControls">
            <button type="button" className="iconOnlyButton" onClick={cancel} aria-label="Cancel edit" title="Cancel">
              <IconX />
            </button>
            <button type="submit" className="iconOnlyButton" aria-label="Submit edit" title="Submit">
              <IconCheck />
            </button>
          </span>
        </form>
      ) : (
        <>
          <MessageContent content={message.content || message.error || ''} />
          <button type="button" className="userEditButton iconOnlyButton" onClick={() => setEditing(true)} aria-label="Edit message" title="Edit">
            <IconPencil />
          </button>
        </>
      )}
    </>
  )
}

function AnimatedStatValue({ value, numericValue, width = '6ch' }) {
  const [display, setDisplay] = useState({
    current: value,
    previous: null,
    direction: 'up',
    animating: false,
  })
  const lastNumberRef = useRef(Number(numericValue))

  useEffect(() => {
    setDisplay((currentDisplay) => {
      if (currentDisplay.current === value) return currentDisplay
      const nextNumber = Number(numericValue)
      const lastNumber = lastNumberRef.current
      const direction = Number.isFinite(nextNumber) && Number.isFinite(lastNumber) && nextNumber < lastNumber ? 'down' : 'up'
      lastNumberRef.current = nextNumber
      return {
        current: value,
        previous: currentDisplay.current,
        direction,
        animating: true,
      }
    })

    const timer = setTimeout(() => {
      setDisplay((currentDisplay) => (
        currentDisplay.current === value
          ? { ...currentDisplay, previous: null, animating: false }
          : currentDisplay
      ))
    }, 280)
    return () => clearTimeout(timer)
  }, [value, numericValue])

  return (
    <span
      className={`statValue ${display.animating ? 'isAnimating' : ''} is${display.direction === 'down' ? 'Down' : 'Up'}`}
      style={{ '--stat-width': width }}
    >
      <span className="statValueItem previous">{display.previous ?? display.current}</span>
      <span className="statValueItem current">{display.current}</span>
    </span>
  )
}

function BackendStats({ selectedModel, active }) {
  const [stats, setStats] = useState(null)
  const [cpuDisplayValue, setCpuDisplayValue] = useState(null)
  const lastCpuDisplayAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timer = null
    const isActive = () => !document.hidden && document.hasFocus()

    async function load() {
      if (typeof adapter.stats !== 'function') return
      try {
        const next = await adapter.stats(selectedModel)
        if (!cancelled) setStats(next)
      } catch {
        if (!cancelled) setStats((current) => current || null)
      }
    }

    const schedule = () => {
      if (timer) clearInterval(timer)
      timer = setInterval(load, isActive() ? (active ? STATS_REFRESH_MS : IDLE_STATS_REFRESH_MS) : INACTIVE_STATS_REFRESH_MS)
    }

    const refreshIfActive = () => {
      if (isActive()) load()
      schedule()
    }

    load()
    schedule()
    document.addEventListener('visibilitychange', refreshIfActive)
    window.addEventListener('focus', refreshIfActive)
    window.addEventListener('blur', schedule)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfActive)
      window.removeEventListener('focus', refreshIfActive)
      window.removeEventListener('blur', schedule)
    }
  }, [selectedModel, active])

  useEffect(() => {
    if (!stats) return
    const now = performance.now()
    if (!lastCpuDisplayAtRef.current || now - lastCpuDisplayAtRef.current >= CPU_DISPLAY_REFRESH_MS) {
      lastCpuDisplayAtRef.current = now
      setCpuDisplayValue(stats.cpu?.usagePercent)
    }
  }, [stats])

  const cpu = formatPercent(cpuDisplayValue)
  const ram = formatBytes(stats?.ram?.rssBytes)
  const gpu = stats?.gpu?.available ? formatPercent(stats.gpu.usagePercent) : '--'

  return (
    <div className="backendStats" aria-live="polite">
      <span className="statItem"><strong>CPU</strong> <AnimatedStatValue value={cpu} numericValue={cpuDisplayValue} width="5.5ch" /></span>
      <span className="statItem"><strong>RAM</strong> <AnimatedStatValue value={ram} numericValue={stats?.ram?.rssBytes} width="9ch" /></span>
      <span className="statItem"><strong>GPU</strong> <AnimatedStatValue value={gpu} numericValue={stats?.gpu?.usagePercent} width="5.5ch" /></span>
    </div>
  )
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${m}m ${s}s`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function normalizeToolCard(card) {
  const action = card?.action && typeof card.action === 'object' ? card.action : card
  const display = card?.display || action?.display || null
  if (!display && !action?.action && !card?.name && !card?.toolName) return null
  return {
    ...card,
    ...action,
    toolCallId: action.toolCallId || card.toolCallId || null,
    toolName: action.toolName || card.name || card.toolName || action.action,
    name: card.name || action.name || card.toolName || action.toolName || action.action,
    status: card.status || action.status || null,
    display,
    at: Number(card.at || action.at || 0) || null,
  }
}

function fallbackToolTitle(card) {
  const name = card.name || card.toolName || card.action || 'Tool'
  return String(name).split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ')
}

function ToolCard({ card, now, messageAt }) {
  const timers = useStore((s) => s.timers)
  const stopwatches = useStore((s) => s.stopwatches)
  const display = card.display || {}
  const actionName = card.action || card.name || card.toolName
  let title = display.title || fallbackToolTitle(card)
  let summary = display.summary || ''
  let status = card.status || ''
  let done = status === 'complete'

  if (actionName === 'timer_start') {
    const local = card.toolCallId ? timers.find((timer) => timer.toolCallId === card.toolCallId) : null
    const durationMs = Math.max(1, Number(card.durationMs || local?.durationMs || 0))
    const startedAt = local?.createdAt || card.startedAt || card.at || messageAt
    const targetAt = local?.targetAt || startedAt + durationMs
    const remaining = targetAt - now
    const cancelled = local?.status === 'cancelled'
    done = !cancelled && remaining <= 0
    title = card.label || local?.label || title || 'Timer'
    summary = cancelled ? 'cancelled' : done ? 'done' : formatDuration(remaining)
    status = cancelled ? 'cancelled' : done ? 'done' : 'running'
  }

  if (actionName === 'stopwatch_start') {
    const local = card.toolCallId ? stopwatches.find((watch) => watch.toolCallId === card.toolCallId) : null
    const startedAt = local?.startedAt || card.startedAt || card.at || messageAt
    const elapsed = local
      ? local.elapsedMs + (local.running ? now - local.startedAt : 0)
      : Math.max(0, now - startedAt)
    title = card.label || local?.label || title || 'Stopwatch'
    summary = formatDuration(elapsed)
    status = local?.running === false ? 'stopped' : 'running'
  }

  const rows = Array.isArray(display.rows) ? display.rows.filter((row) => row?.label && row?.value != null) : []
  const links = Array.isArray(display.links) ? display.links.filter((link) => link?.url) : []
  const items = Array.isArray(display.items) ? display.items.filter(Boolean) : []

  return (
    <div className={`messageToolCard ${done ? 'isDone' : ''} ${status === 'running' ? 'isRunning' : ''} ${status === 'error' ? 'isError' : ''}`}>
      <div className="toolCardHeader">
        <strong>{title}</strong>
        {status && <span className="toolCardStatus">{status}</span>}
      </div>
      {summary && <span className="messageToolCardSummary">{summary}</span>}
      {display.color && <span className="toolColorSwatch" style={{ backgroundColor: display.color }} aria-label={display.color} />}
      {rows.length > 0 && (
        <dl className="toolCardRows">
          {rows.slice(0, 6).map((row, index) => (
            <React.Fragment key={`${row.label}-${index}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {links.length > 0 && (
        <div className="toolCardLinks">
          {links.slice(0, 3).map((link, index) => (
            <a href={link.url} target="_blank" rel="noreferrer" key={`${link.url}-${index}`}>{link.title || link.url}</a>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <ul className="toolCardItems">
          {items.slice(0, 5).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      )}
      {display.code && <pre className="toolCardCode">{display.code}</pre>}
      {card.error && status === 'error' && <span className="toolCardError">{card.error}</span>}
    </div>
  )
}

function MessageToolCards({ message, toolCards = [], now }) {
  const rawCards = toolCards.length
    ? toolCards
    : (message?.toolCards || message?.metrics?.toolCards || message?.metadata?.metrics?.toolCards || message?.metrics?.toolActions || message?.metadata?.metrics?.toolActions || [])
  const cards = rawCards
    .map(normalizeToolCard)
    .filter(Boolean)
    .slice(0, 8)

  if (!cards.length) return null

  const messageAt = Date.parse(message?.completedAt || message?.createdAt || '') || Date.now()

  return (
    <div className="messageToolCards" aria-live="polite">
      {cards.map((card, index) => (
        <ToolCard card={card} now={now} messageAt={messageAt} key={card.toolCallId || card.id || `${card.name || card.action}-${index}`} />
      ))}
    </div>
  )
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
      <svg className="searchIcon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.25" />
        <path d="M12.5 12.5 17 17" />
      </svg>
      <input ref={inputRef} className="searchInput" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="" aria-label="Search chats" />
      {!query && (
        <span className="searchPlaceholder" aria-hidden="true">
          <span className="cmdSymbol">⌘</span>
          <span className="shortcutPlus">+</span>
          <span>F</span>
        </span>
      )}
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

function SelectControl({ id, label, value, onChange, options, open, onOpen, onClose }) {
  const selected = options.find(([optionValue]) => String(optionValue) === String(value)) || options[0]
  const selectedLabel = selected?.[1] || ''

  const choose = (nextValue) => {
    onChange(nextValue)
    onClose()
  }

  return (
    <div className="settingsField customSelectField">
      <span>{label}</span>
      <div className={`customSelect ${open ? 'isOpen' : ''}`}>
        <button
          className="customSelectButton"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          onClick={() => open ? onClose() : onOpen(id)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen(id)
            }
          }}
        >
          <span>{selectedLabel}</span>
          <span className="customSelectChevron" aria-hidden="true" />
        </button>
        {open && (
          <div className="customSelectMenu" id={`${id}-listbox`} role="listbox" tabIndex={-1}>
            {options.map(([optionValue, labelText]) => {
              const isSelected = String(optionValue) === String(value)
              return (
                <button
                  key={optionValue}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={isSelected ? 'isSelected' : ''}
                  onClick={() => choose(optionValue)}
                >
                  <span>{labelText}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
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

function LocalSearchStatus({ open }) {
  const [status, setStatus] = useState(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open || typeof adapter.searchStatus !== 'function') return
    let cancelled = false
    async function load() {
      try {
        const next = await adapter.searchStatus()
        if (!cancelled) setStatus(next)
      } catch {
        if (!cancelled) setStatus({ ready: false, state: 'unavailable', message: 'Local search is unavailable.' })
      }
    }
    load()
    const timer = setInterval(load, 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open])

  if (!open) return null
  const state = status?.ready ? 'ready' : status?.state || 'checking'
  const canStart = !status?.ready && status?.managed !== false && typeof adapter.startSearch === 'function'
  const start = async () => {
    if (starting) return
    setStarting(true)
    try {
      setStatus(await adapter.startSearch())
      const next = await adapter.searchStatus?.()
      if (next) setStatus(next)
    } catch {
      setStatus({ ready: false, state: 'unavailable', message: 'Could not start local search.' })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className={`settingsSearchStatus is-${state}`}>
      <div>
        <strong>Local search: {state}</strong>
        <span>{status?.message || 'Checking local SearXNG.'}</span>
      </div>
      {canStart && (
        <button type="button" onClick={start} disabled={starting}>
          {starting ? 'Starting' : 'Start'}
        </button>
      )}
    </div>
  )
}

function SettingsModelDownloads({ open }) {
  const [status, setStatus] = useState(null)
  const [busyKey, setBusyKey] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const next = await (adapter.mlxModelDownloadStatus?.() ?? adapter.mlxModelsStatus())
        if (!cancelled) setStatus(next)
      } catch {
        if (!cancelled) setStatus({ status: 'unavailable', error: 'MLX runner is not ready.' })
      }
    }
    load()
    const timer = setInterval(load, status?.status === 'downloading' || status?.status === 'retrying' ? 500 : 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open, status?.status])

  const missing = status?.missing || []
  const missingModels = (status?.models || []).filter((item) => missing.includes(item.key))
  const downloading = status?.status === 'downloading' || status?.status === 'retrying'
  const pct = Math.max(0, Math.min(100, Number(status?.pct || 0)))
  const currentLabel = status?.currentModel || 'MLX model'

  if (!open || (!missingModels.length && !downloading && !status?.error)) return null

  const startDownload = async (modelKey) => {
    setBusyKey(modelKey)
    try {
      setStatus(await adapter.startMlxModelDownload(modelKey))
    } catch {
      setStatus((current) => ({
        ...(current || {}),
        status: 'unavailable',
        error: 'Download failed.',
      }))
    } finally {
      setBusyKey('')
    }
  }

  return (
    <div className="settingsModelDownloads">
      <span className="settingsModelDownloadsTitle">Downloads</span>
      {status?.error && <small>{status.error}</small>}
      {downloading && (
        <div className="settingsDownloadProgress">
          <small>{currentLabel}</small>
          <div className="downloadBar"><span style={{ width: `${pct}%` }} /></div>
          <small>{downloadProgressText(status)}</small>
        </div>
      )}
      {!downloading && missingModels.map((model) => (
        <button key={model.key} type="button" onClick={() => startDownload(model.key)} disabled={Boolean(busyKey)}>
          <span>{model.label}</span>
          <small>{model.pinned ? 'Kept loaded' : 'On demand'} · {model.details?.parameterSize || 'MLX'} · {model.backend}</small>
        </button>
      ))}
    </div>
  )
}

function Settings({ models, selectedModel, setSelectedModel, onUnloadModels }) {
  const [open, setOpen] = useState(false)
  const [renderPanel, setRenderPanel] = useState(false)
  const [closing, setClosing] = useState(false)
  const [unloadState, setUnloadState] = useState({ loading: false, message: '' })
  const [openSelect, setOpenSelect] = useState(null)
  const wrapRef = useRef(null)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const colorMode = useStore((s) => s.colorMode)
  const setColorMode = useStore((s) => s.setColorMode)
  const userName = useStore((s) => s.userName)
  const setUserName = useStore((s) => s.setUserName)
  const showMetrics = useStore((s) => s.showMetrics)
  const setShowMetrics = useStore((s) => s.setShowMetrics)
  const webSearchEnabled = useStore((s) => s.webSearchEnabled)
  const setWebSearchEnabled = useStore((s) => s.setWebSearchEnabled)
  const searchStrategy = useStore((s) => s.searchStrategy)
  const setSearchStrategy = useStore((s) => s.setSearchStrategy)
  const contextSize = useStore((s) => s.contextSize)
  const setContextSize = useStore((s) => s.setContextSize)
  const modelResidency = useStore((s) => s.modelResidency)
  const setModelResidency = useStore((s) => s.setModelResidency)
  const modelOptions = models.map((model) => [model, model])

  useEffect(() => {
    if (!open) setOpenSelect(null)
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
      if (event.key === 'Escape') {
        if (openSelect) {
          setOpenSelect(null)
          return
        }
        setOpen(false)
        return
      }
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeIfOutside, true)
    document.addEventListener('keydown', closeOnTypingOutside, true)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true)
      document.removeEventListener('keydown', closeOnTypingOutside, true)
    }
  }, [open, openSelect])

  const handleUnloadModels = async () => {
    if (unloadState.loading) return
    setUnloadState({ loading: true, message: '' })
    try {
      const result = await onUnloadModels()
      const count = result?.count ?? result?.unloaded?.length ?? 0
      setUnloadState({
        loading: false,
        message: count ? `Unloaded ${count}` : 'Nothing loaded'
      })
    } catch {
      setUnloadState({ loading: false, message: 'Unload failed' })
    }
  }

  const selectProps = {
    open: false,
    onOpen: setOpenSelect,
    onClose: () => setOpenSelect(null),
  }

  return (
    <div className="settingsWrap" ref={wrapRef}>
      <button className="iconButton settingsButton" onClick={() => setOpen((v) => !v)} aria-label="Settings">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
          <path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.4-2.4 1a8.6 8.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A8.6 8.6 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.4 2.4-1a8.6 8.6 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8.6 8.6 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5Z" />
        </svg>
      </button>
      {renderPanel && (
        <section className={`settingsPanel ${closing ? 'isClosing' : ''}`}>
          <div className="settingsTitle">Settings</div>
          <SelectControl id="theme" label="Theme" value={theme} onChange={setTheme} options={THEMES} {...selectProps} open={openSelect === 'theme'} />
          <SelectControl id="appearance" label="Appearance" value={colorMode} onChange={setColorMode} options={COLOR_MODES} {...selectProps} open={openSelect === 'appearance'} />
          <TextControl label="Name" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your name" />
          <SelectControl id="model" label="Model" value={selectedModel} onChange={setSelectedModel} options={modelOptions} {...selectProps} open={openSelect === 'model'} />
          <SettingsModelDownloads open={open} />
          <SelectControl id="context" label="Context" value={contextSize} onChange={(next) => setContextSize(Number(next))} options={CONTEXT_OPTIONS} {...selectProps} open={openSelect === 'context'} />
          <SelectControl id="residency" label="Residency" value={modelResidency} onChange={setModelResidency} options={RESIDENCY_OPTIONS} {...selectProps} open={openSelect === 'residency'} />
          <label className="checkRow">
            <input type="checkbox" checked={showMetrics} onChange={(e) => setShowMetrics(e.target.checked)} />
            <span className="customCheck" aria-hidden="true" />
            <span>Show token timing</span>
          </label>
          <label className="checkRow">
            <input type="checkbox" checked={webSearchEnabled} onChange={(e) => setWebSearchEnabled(e.target.checked)} />
            <span className="customCheck" aria-hidden="true" />
            <span>Allow web search</span>
          </label>
          <SelectControl id="searchStrategy" label="Search mode" value={searchStrategy} onChange={setSearchStrategy} options={SEARCH_STRATEGY_OPTIONS} {...selectProps} open={openSelect === 'searchStrategy'} />
          <LocalSearchStatus open={open} />
          <button className="settingsActionButton" type="button" onClick={handleUnloadModels} disabled={unloadState.loading}>
            {unloadState.loading ? 'Unloading...' : 'Unload models'}
          </button>
          {unloadState.message && <div className="settingsStatus">{unloadState.message}</div>}
        </section>
      )}
    </div>
  )
}

function AttachmentStrip({ attachments }) {
  if (!attachments?.length) return null
  return (
    <div className="messageAttachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="messageAttachment">
          <img src={attachment.url} alt={attachment.name || 'Attached image'} />
        </a>
      ))}
    </div>
  )
}

function shouldPollModelDownloadStatus(status, preflight, dismissed) {
  if (!status) return true
  const missing = status?.missing || []
  const readyModels = (status?.models || []).filter((item) => item.ready)
  const missingModels = (status?.models || []).filter((item) => missing.includes(item.key))
  const downloading = status?.status === 'downloading' || status?.status === 'retrying'
  const runtimeBlocked = preflight?.ok === false
  const needsInitialModel = readyModels.length === 0 && missingModels.length > 0
  if (downloading) return true
  if (dismissed) return missingModels.length > 0
  return runtimeBlocked || needsInitialModel || missingModels.length > 0 || ['error', 'unavailable'].includes(status?.status)
}

function ChatCard({ chatId, active, messages, streamingContent, streamMetrics, streamToolCards, isStreaming, now, wallNow, userName, onRegenerate, onEditUserMessage }) {
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
          <section key={message.id} className={`message ${message.role} ${message.status === 'error' ? 'isError' : ''}`}>
            {message.role === 'user' ? (
              <UserMessageBubble message={message} onEditUserMessage={onEditUserMessage} />
            ) : (
              <>
                <AttachmentStrip attachments={message.attachments} />
                <MessageContent content={message.content || message.error || ''} />
                <MessageToolCards message={message} now={wallNow} />
                <div className="messageFooter">
                  <MessageMetrics metrics={message.metrics} now={now} />
                  <MessageActions message={message} onRegenerate={onRegenerate} />
                </div>
              </>
            )}
          </section>
        ))}
        {active && isStreaming && (
          <section className="message assistant isStreaming">
            <MessageContent content={streamingContent || ' '} />
            <MessageToolCards message={{ createdAt: new Date().toISOString() }} toolCards={streamToolCards} now={wallNow} />
            <MessageMetrics metrics={streamMetrics} now={now} streaming />
          </section>
        )}
        <div ref={bottomRef} />
      </div>
    </article>
  )
}

function ModelDownloadToast() {
  const [status, setStatus] = useState(null)
  const [preflight, setPreflight] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    async function load() {
      try {
        const [next, runtime] = await Promise.all([
          adapter.mlxModelDownloadStatus?.() ?? adapter.mlxModelsStatus(),
          adapter.mlxPreflight?.().catch((error) => ({ ok: false, message: error.message })),
        ])
        if (!cancelled) {
          setStatus(next)
          setPreflight(runtime)
        }
        return { next, runtime }
      } catch {
        if (!cancelled) setStatus({ status: 'unavailable', error: 'MLX runner is not ready.' })
        return { next: { status: 'unavailable' }, runtime: preflight }
      }
    }

    async function poll() {
      const { next, runtime } = await load()
      if (cancelled) return
      if (shouldPollModelDownloadStatus(next, runtime, dismissed)) {
        const live = next?.status === 'downloading' || next?.status === 'retrying'
        timer = window.setTimeout(poll, live ? 500 : 3500)
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [dismissed, preflight?.ok, status?.status, status?.missing?.join('|')])

  const missing = status?.missing || []
  const readyModels = (status?.models || []).filter((item) => item.ready)
  const missingModels = (status?.models || []).filter((item) => missing.includes(item.key))
  const downloading = status?.status === 'downloading' || status?.status === 'retrying'
  const runtimeBlocked = preflight?.ok === false
  const needsInitialModel = readyModels.length === 0 && missingModels.length > 0
  const active = downloading || (!dismissed && (runtimeBlocked || needsInitialModel || ['error', 'unavailable'].includes(status?.status)))
  if (!active) return null

  const model = (status?.models || []).find((item) => item.label === status?.currentModel) || missingModels[0] || status?.models?.[0]
  const pct = Math.max(0, Math.min(100, Number(status?.pct || 0)))
  const missingText = missing.length > 1 ? ` ${missing.length} models are missing.` : ''
  const statusText = runtimeBlocked
    ? preflight.message || 'MLX cannot see a Metal device from this process.'
    : status?.error || (downloading ? status?.step || 'Downloading model' : `Download this MLX model when you want it available.${missingText}`)

  const startDownload = async (modelKey) => {
    setBusy(true)
    try {
      setStatus(await adapter.startMlxModelDownload(modelKey || model?.key))
    } catch {
      setStatus((current) => ({
        ...(current || {}),
        status: 'unavailable',
        error: 'Run npm run setup:mlx, restart the backend, then download the model.',
      }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`modelDownloadToast ${downloading ? 'isDownloading' : ''}`} role="status" aria-live="polite">
      <div className="modelDownloadToastBody">
        <strong>{model?.label || 'Qwen3.5 9B MLX 4-bit'}</strong>
        <span>{statusText}</span>
      </div>
      {!downloading && missingModels.length > 0 && (
        <div className="downloadChoices">
          {missingModels.map((item) => (
            <button key={item.key} type="button" onClick={() => startDownload(item.key)} disabled={busy}>
              <span>{item.label}</span>
              <small>{item.pinned ? 'Kept loaded' : 'On demand'} · {item.details?.parameterSize || 'MLX'} · {item.backend}</small>
            </button>
          ))}
        </div>
      )}
      {downloading && (
        <div className="downloadProgress">
          <div className="downloadBar"><span style={{ width: `${pct}%` }} /></div>
          <small>{downloadProgressText(status)}</small>
        </div>
      )}
      <div className="downloadActions">
        <button onClick={() => adapter.openMlxModelsFolder().catch(() => {})}>Open folder</button>
        <button onClick={() => setDismissed(true)}>Dismiss</button>
      </div>
    </section>
  )
}

export default function App() {
  const theme = useStore((s) => s.theme)
  const colorMode = useStore((s) => s.colorMode)
  const userName = useStore((s) => s.userName).trim()
  const {
    models, selectedModel, setSelectedModel,
    chats, currentChatId, messages, streamingContent, isStreaming, streamMetrics, queuedMessages,
    streamToolCards,
    input, setInput, pendingAttachments, loadModels, loadChats, selectChat, newChat, unloadModels, sendMessage, stopGeneration, regenerate, editUserMessage, handleKeyDown,
  } = useChat()
  const addPendingAttachments = useStore((s) => s.addPendingAttachments)
  const removePendingAttachment = useStore((s) => s.removePendingAttachment)
  const messagesByChat = useStore((s) => s.messagesByChat)
  const hasLiveToolClock = useStore((s) => (
    s.timers.some((timer) => timer.status === 'active') ||
    s.stopwatches.some((watch) => watch.running)
  ))
  const [now, setNow] = useState(() => performance.now())
  const [wallNow, setWallNow] = useState(() => Date.now())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const bootstrappedRef = useRef(false)

  useEffect(() => {
    if (bootstrappedRef.current) return
    bootstrappedRef.current = true
    async function bootstrap() {
      await loadModels()
      const loaded = await loadChats()
      const ordered = orderChats(loaded)
      const reusable = [...ordered].reverse().find((chat) => {
        const cachedMessages = useStore.getState().messagesByChat[chat.id]
        const knownEmpty = chat.messageCount === 0 || cachedMessages?.length === 0
        const looksUntitled = !chat.title || /^new chat$/i.test(chat.title)
        return knownEmpty && looksUntitled
      })
      if (reusable) selectChat(reusable.id)
      else newChat()
    }
    bootstrap()
  }, [])

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(performance.now()), 120)
    return () => clearInterval(timer)
  }, [isStreaming])

  useEffect(() => {
    if (!hasLiveToolClock) return
    const timer = setInterval(() => setWallNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [hasLiveToolClock])

  useEffect(() => {
    const focusComposer = () => inputRef.current?.focus({ preventScroll: true })
    requestAnimationFrame(focusComposer)
    const timer = setTimeout(focusComposer, 80)
    return () => clearTimeout(timer)
  }, [currentChatId])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (event) => setSystemDark(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])

  const orderedChats = useMemo(() => orderChats(chats), [chats])
  const currentIndex = Math.max(0, orderedChats.findIndex((chat) => chat.id === currentChatId))
  const currentChat = orderedChats[currentIndex]

  const openNewThread = (force = false) => {
    if (isStreaming) return
    if (!force && currentChat && messages.length === 0) {
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


  const resolvedColorMode = colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode
  const currentQueue = queuedMessages.filter((message) => message.chatId === currentChatId)
  const hasDraft = input.trim() || pendingAttachments.length > 0
  const actionLabel = isStreaming ? (hasDraft ? 'Queue' : 'Stop') : 'Send'
  const handleComposerAction = () => {
    if (isStreaming && !hasDraft) stopGeneration()
    else sendMessage()
  }
  const addImageFiles = (files) => {
    const images = Array.from(files || []).filter((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size <= 20 * 1024 * 1024)
    if (images.length) addPendingAttachments(images)
  }

  return (
    <div className={`app theme-${theme} color-${resolvedColorMode}`}>
      <div className="themeFade" aria-hidden="true" />
      <header className="topBar">
        <div className="topSearch">
          <SearchBox chats={orderedChats} onSelect={selectChat} />
        </div>
        <button className="brandButton" onClick={() => openNewThread()}>naow</button>
        <Settings models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} onUnloadModels={unloadModels} />
      </header>
      <ModelDownloadToast />

      <main className="stage">
        <div className="chatViewport">
          <ChatCard
            chatId={currentChat?.id || currentChatId}
            active
            messages={messages}
            streamingContent={streamingContent}
            streamMetrics={streamMetrics}
            streamToolCards={streamToolCards}
            isStreaming={isStreaming}
            now={now}
            wallNow={wallNow}
            userName={userName}
            onRegenerate={regenerate}
            onEditUserMessage={editUserMessage}
          />
        </div>
        <button className="newThreadButton" onClick={() => openNewThread()} aria-label="New thread">
          <span>+</span>
        </button>
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
        {pendingAttachments.length > 0 && (
          <div className="attachmentTray">
            {pendingAttachments.map((attachment) => (
              <div className="attachmentChip" key={attachment.id}>
                <img src={attachment.previewUrl} alt={attachment.name} />
                <span>{attachment.name}</span>
                <button onClick={() => removePendingAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>×</button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(event) => {
            addImageFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <div
          className="composerShell"
          onDragOver={(event) => {
            event.preventDefault()
            event.currentTarget.classList.add('isDropping')
          }}
          onDragLeave={(event) => event.currentTarget.classList.remove('isDropping')}
          onDrop={(event) => {
            event.preventDefault()
            event.currentTarget.classList.remove('isDropping')
            addImageFiles(event.dataTransfer.files)
          }}
        >
          <button className="attachButton" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach image">+</button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(event) => addImageFiles(event.clipboardData?.files)}
            disabled={!currentChat}
            placeholder={isStreaming ? 'Queue the next message' : 'Message naow'}
            rows={1}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 138)}px` }}
          />
          <div className="composerActions">
            <button className="sendButton" onClick={handleComposerAction}>{actionLabel}</button>
          </div>
        </div>
        <BackendStats selectedModel={selectedModel} active={isStreaming} />
      </footer>
    </div>
  )
}
