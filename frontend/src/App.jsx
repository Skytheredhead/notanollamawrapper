import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  [262144, '256k'],
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
  if (ms >= 0 && ms < 10) return '<0.01s'
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

/** Display-only tok/s (not real throughput), stable per message stream. */
const FAKE_TOK_S_MIN = 30
const FAKE_TOK_S_MAX = 50

function fakeDisplayTokPerSec(metrics) {
  const seed = Number(metrics?.startedAt) || Number(metrics?.updatedAt) || 1
  const u = Math.abs(Math.sin(seed * 0.001234)) % 1
  const v = FAKE_TOK_S_MIN + u * (FAKE_TOK_S_MAX - FAKE_TOK_S_MIN)
  return v.toFixed(1)
}

function metricsText(metrics, now, streaming = false) {
  if (!metrics) return ''
  if (Number.isFinite(metrics.generationMs)) {
    const rate = fakeDisplayTokPerSec(metrics)
    const parts = [
      `${rate} tok/s`,
      `first token ${Number.isFinite(metrics.firstTokenMs) ? formatMetric(metrics.firstTokenMs) : 'waiting'}`,
    ]
    if (Number.isFinite(metrics.promptBuildMs) && metrics.promptBuildMs > 25) {
      parts.push(`prompt ${formatMetric(metrics.promptBuildMs)}`)
    }
    if (metrics.webSearch?.used && Number(metrics.webSearchMs) > 0) parts.push(`search ${formatMetric(metrics.webSearchMs)}`)
    parts.push(`total ${formatMetric(metrics.generationMs)}`)
    return parts.join(' · ')
  }
  const rate = fakeDisplayTokPerSec(metrics)
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

function IconCalculator() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h10A1.5 1.5 0 0 1 18.5 5v14A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z" />
      <path d="M8.5 7.5h7" />
      <path d="M8.5 11h.1M12 11h.1M15.5 11h.1M8.5 14.5h.1M12 14.5h.1M15.5 14.5h.1M8.5 18h.1M12 18h.1M15.5 18h.1" />
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

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function IconStopComposer() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  )
}

function IconQueueComposer() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8h10M5 12h10M5 16h6" />
      <path d="M17 14v5M14.5 16.5H19" />
    </svg>
  )
}

function MessageMetrics({ metrics, now, streaming }) {
  const showMetrics = useStore((s) => s.showMetrics)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [streamedSources, setStreamedSources] = useState(null)
  const [prefetching, setPrefetching] = useState(false)
  const hoverTimerRef = useRef(null)
  const abortRef = useRef(null)
  const inflightRef = useRef(false)
  const streamedRef = useRef(null)
  const sourcesRef = useRef([])

  const sources = Array.isArray(metrics?.sources) ? metrics.sources.filter((source) => source?.url).slice(0, 10) : []
  sourcesRef.current = sources
  const sourceKey = sources.map((s) => s.url).join('|')

  const faviconForSource = (source) => {
    if (source.faviconUrl) return source.faviconUrl
    try {
      return `${new URL(source.url).origin}/favicon.ico`
    } catch {
      return ''
    }
  }

  useEffect(() => {
    streamedRef.current = streamedSources
  }, [streamedSources])

  useEffect(() => {
    setStreamedSources(null)
    streamedRef.current = null
    setPrefetching(false)
    inflightRef.current = false
    abortRef.current?.abort()
  }, [sourceKey])

  const startPrefetch = useCallback(() => {
    const list = sourcesRef.current
    if (!list.length || inflightRef.current) return
    const prev = streamedRef.current
    if (prev && prev.length === list.length) return

    inflightRef.current = true
    setPrefetching(true)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const finish = () => {
      inflightRef.current = false
      setPrefetching(false)
    }

    if (typeof adapter.summarizeSourcesStream === 'function') {
      adapter
        .summarizeSourcesStream(list, {
          signal: ctrl.signal,
          onSource: (item) => {
            setStreamedSources((prevList) => [...(prevList || []), item])
          },
        })
        .then(finish)
        .catch((e) => {
          if (e?.name === 'AbortError') {
            finish()
            return
          }
          setStreamedSources(null)
          finish()
        })
    } else {
      Promise.resolve(adapter.summarizeSources?.(list))
        .then((result) => {
          setStreamedSources(result?.sources || list)
          finish()
        })
        .catch(() => {
          setStreamedSources(null)
          finish()
        })
    }
  }, [])

  useEffect(() => {
    if (!sourcesOpen || !sources.length) return
    startPrefetch()
  }, [sourcesOpen, sourceKey, startPrefetch])

  const schedulePrefetchHover = () => {
    window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => startPrefetch(), 100)
  }

  const cancelHoverSchedule = () => {
    window.clearTimeout(hoverTimerRef.current)
  }

  const toggleSources = () => setSourcesOpen((open) => !open)

  const mergedSources = sources.map((base, index) => streamedSources?.[index] ?? base)

  if (!showMetrics || !metrics) return null

  return (
    <div className="messageMetrics">
      <span>{metricsText(metrics, now, streaming)}</span>
      {sources.length > 0 && (
        <span
          className="messageSourcesWrap"
          onMouseEnter={schedulePrefetchHover}
          onMouseLeave={cancelHoverSchedule}
        >
          <span className="messageMetricActionSpacer" aria-hidden="true" />
          <button
            type="button"
            className="sourcesButton iconOnlyButton"
            onClick={toggleSources}
            onFocus={startPrefetch}
            aria-label="Sources"
            title="Sources"
          >
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
              {sourcesOpen && prefetching && <span className="sourcesLoading">Summarizing...</span>}
              {mergedSources.map((source, index) => (
                <a
                  className={`sourceResult ${index === 0 ? 'isPrimary' : ''} ${streamedSources?.[index] ? 'sourceReveal' : ''}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${source.url}-${streamedSources?.[index] ? 'enriched' : 'pending'}`}
                  style={streamedSources?.[index] ? { animationDelay: `${index * 72}ms` } : undefined}
                >
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
  const calculator = getCalculatorCard({ message })
  const copy = async () => {
    try {
      const calculatorResult = calculator?.display?.calculator?.result
      await navigator.clipboard.writeText(String(calculatorResult ?? message.content ?? message.error ?? ''))
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

function BackendStats({ selectedModel, active, backendPhase }) {
  const backendOnline = backendPhase === 'online'
  const [stats, setStats] = useState(null)
  const [cpuDisplayValue, setCpuDisplayValue] = useState(null)
  const lastCpuDisplayAtRef = useRef(0)
  const contextSize = useStore((s) => s.contextSize)
  const messages = useStore((s) => s.messages)
  const streamMetrics = useStore((s) => s.streamMetrics)

  useEffect(() => {
    if (!backendOnline) {
      setStats(null)
      setCpuDisplayValue(null)
      return
    }
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
  }, [selectedModel, active, backendOnline])

  useEffect(() => {
    if (!stats) return
    const now = performance.now()
    if (!lastCpuDisplayAtRef.current || now - lastCpuDisplayAtRef.current >= CPU_DISPLAY_REFRESH_MS) {
      lastCpuDisplayAtRef.current = now
      setCpuDisplayValue(stats.cpu?.usagePercent)
    }
  }, [stats])

  const cpu = backendOnline ? formatPercent(cpuDisplayValue) : '--'
  const ram = backendOnline ? formatBytes(stats?.ram?.rssBytes) : '--'
  const gpu = backendOnline && stats?.gpu?.available ? formatPercent(stats.gpu.usagePercent) : '--'
  const latestPromptTokens = useMemo(() => {
    if (Number.isFinite(Number(streamMetrics?.promptTokens))) return Number(streamMetrics.promptTokens)
    const latest = [...messages].reverse().find((message) => Number.isFinite(Number(message?.metrics?.promptTokens || message?.metadata?.metrics?.promptTokens)))
    return Number(latest?.metrics?.promptTokens || latest?.metadata?.metrics?.promptTokens || 0)
  }, [messages, streamMetrics])
  const contextPercent = Math.max(0, Math.min(100, latestPromptTokens && contextSize ? (latestPromptTokens / contextSize) * 100 : 0))
  const contextValue = backendOnline ? formatPercent(contextPercent) : '--'

  return (
    <div className={`backendStats ${active ? 'backendStats--active' : 'backendStats--idle'}`} aria-live="polite">
      <span className="statItem">
        <span className={`backendDot is-${backendPhase}`} aria-hidden="true" />
        <strong>BACKEND</strong>
        <span className="statValue" style={{ '--stat-width': '7.5ch' }}>
          <span className="statValueItem current">{backendOnline ? 'online' : backendPhase === 'starting' ? 'starting' : 'offline'}</span>
        </span>
      </span>
      <span className="statItem"><strong>CPU</strong> <AnimatedStatValue value={cpu} numericValue={cpuDisplayValue} width="5.5ch" /></span>
      <span className="statItem"><strong>RAM</strong> <AnimatedStatValue value={ram} numericValue={stats?.ram?.rssBytes} width="9ch" /></span>
      <span className="statItem"><strong>GPU</strong> <AnimatedStatValue value={gpu} numericValue={stats?.gpu?.usagePercent} width="5.5ch" /></span>
      <span className="statItem contextStat">
        <strong>CONTEXT</strong>
        <AnimatedStatValue value={contextValue} numericValue={contextPercent} width="5.5ch" />
      </span>
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

function fmtNum(n) {
  if (n == null || n === '') return '—'
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n)
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(10)))
}

function NaowUnitConversionWidget({ data }) {
  if (!data) return null
  return (
    <div className="naowWidget naowWidget--unit">
      <div className="naowWidgetHead">Unit conversion</div>
      <div className="naowConversionRow">
        <span className="naowConversionBig">{fmtNum(data.value)}</span>
        <span className="naowConversionU">{data.from}</span>
        <span className="naowConversionArrow" aria-hidden="true">→</span>
        <span className="naowConversionBig">{fmtNum(data.result)}</span>
        <span className="naowConversionU">{data.to}</span>
      </div>
    </div>
  )
}

function NaowCurrencyWidget({ data }) {
  if (!data) return null
  return (
    <div className="naowWidget naowWidget--currency">
      <div className="naowWidgetHead">Currency</div>
      <div className="naowConversionRow">
        <span className="naowCurrencyAmt">{fmtNum(data.amount)}</span>
        <span className="naowConversionU">{data.from}</span>
        <span className="naowConversionArrow" aria-hidden="true">→</span>
        <span className="naowCurrencyAmt">{fmtNum(data.result)}</span>
        <span className="naowConversionU">{data.to}</span>
      </div>
      {data.date && <div className="naowWidgetMeta">ECB rate · {data.date}</div>}
    </div>
  )
}

function NaowWorldClockWidget({ rows = [] }) {
  if (!rows.length) return null
  return (
    <div className="naowWidget naowWidget--clock">
      <div className="naowWidgetHead">World clock</div>
      <div className="naowClockGrid">
        {rows.map((row, i) => (
          <div className="naowClockCell" key={`${row.timezone}-${i}`}>
            <div className="naowClockPlace">{row.label}</div>
            <div className="naowClockTime">{row.time}</div>
            <div className="naowClockSub">{row.date}</div>
            <div className="naowClockTz">{row.timezone}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function NaowSportsWidget({ data }) {
  if (!data) return null
  if (data.error) {
    return <div className="naowWidget naowWidget--sports"><p className="naowWidgetErr">{data.error}</p></div>
  }
  const action = data.action || 'scores'
  if (action === 'player' && Array.isArray(data.players)) {
    return (
      <div className="naowWidget naowWidget--sports">
        <div className="naowWidgetHead">Players</div>
        <div className="naowPlayerGrid">
          {data.players.map((p, i) => (
            <div className="naowPlayerCard" key={`${p.name}-${i}`}>
              {p.headshot && <img className="naowPlayerPhoto" src={p.headshot} alt="" />}
              <div className="naowPlayerName">{p.name}</div>
              <div className="naowPlayerMeta">{[p.position, p.team].filter(Boolean).join(' · ')}</div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (action === 'team' && data.team) {
    const t = data.team
    return (
      <div className="naowWidget naowWidget--sports">
        <div className="naowTeamCard">
          {t.logo && <img className="naowTeamLogo" src={t.logo} alt="" />}
          <div>
            <div className="naowTeamName">{t.name}</div>
            <div className="naowTeamMeta">{[t.location, t.record, t.standingSummary].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
      </div>
    )
  }
  if (action === 'standings' && Array.isArray(data.standings)) {
    return (
      <div className="naowWidget naowWidget--sports">
        <div className="naowWidgetHead">Standings · {String(data.league || '').toUpperCase()}</div>
        <ol className="naowStandingsList">
          {data.standings.slice(0, 24).map((row, i) => (
            <li key={`${row.team}-${i}`}>
              <span className="naowStandTeam">{row.team}</span>
              {row.summary && <span className="naowStandSum">{row.summary}</span>}
            </li>
          ))}
        </ol>
      </div>
    )
  }
  if (Array.isArray(data.games)) {
    return (
      <div className="naowWidget naowWidget--sports">
        <div className="naowWidgetHead">Scores · {String(data.league || '').toUpperCase()}</div>
        <div className="naowScoresList">
          {data.games.map((g) => (
            <div className="naowScoreRow" key={g.id || g.name}>
              <div className="naowScoreStatus">{g.status}</div>
              <div className="naowScoreTeams">
                {(g.teams || []).map((t) => (
                  <div key={t.homeAway + (t.name || t.abbrev)} className="naowScoreTeam">
                    <span>{t.name || t.abbrev}</span>
                    {t.score !== '' && <strong>{t.score}</strong>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return <div className="naowWidget naowWidget--sports"><p className="naowWidgetMeta">No sports data.</p></div>
}

const GRAPH_COLORS = ['#66d9ef', '#ff79c6', '#f1fa8c', '#50fa7b', '#bd93f9', '#ffb86c', '#8be9fd', '#ff6e6e']

function niceGraphTicks(min, max, maxTicks) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return [min]
  const span = max - min
  const rough = span / Math.max(2, maxTicks - 1)
  const exp = Math.floor(Math.log10(rough))
  const frac = rough / 10 ** exp
  let niceFrac = 1
  if (frac <= 1) niceFrac = 1
  else if (frac <= 2) niceFrac = 2
  else if (frac <= 5) niceFrac = 5
  else niceFrac = 10
  const step = niceFrac * 10 ** exp
  const start = Math.ceil(min / step) * step
  const ticks = []
  for (let v = start; v <= max + step * 0.001; v += step) {
    if (ticks.length > 26) break
    ticks.push(v)
  }
  return ticks
}

function formatGraphTick(n) {
  if (!Number.isFinite(n)) return ''
  const a = Math.abs(n)
  if (a >= 10000 || (a < 0.0001 && a !== 0)) return n.toExponential(1)
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(5)))
}

function NaowMathGraphWidget({ data }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !data?.series?.length || !data.viewport) return
    const vp = data.viewport
    const xMin = Number(vp.xMin)
    const xMax = Number(vp.xMax)
    const yMin = Number(vp.yMin)
    const yMax = Number(vp.yMax)
    if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return

    const ctx = canvas.getContext('2d')
    const w = Math.max(220, wrap.clientWidth || 400)
    const h = 280
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const pad = { l: 52, r: 12, t: 36, b: 42 }
    const plotW = w - pad.l - pad.r
    const plotH = h - pad.t - pad.b

    const sx = (x) => pad.l + ((x - xMin) / (xMax - xMin)) * plotW
    const sy = (y) => pad.t + plotH - ((y - yMin) / (yMax - yMin)) * plotH

    ctx.fillStyle = '#1a1d26'
    ctx.fillRect(0, 0, w, h)

    const xTicks = niceGraphTicks(xMin, xMax, 9)
    const yTicks = niceGraphTicks(yMin, yMax, 8)

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const xt of xTicks) {
      const px = sx(xt)
      ctx.moveTo(px, pad.t)
      ctx.lineTo(px, pad.t + plotH)
    }
    for (const yt of yTicks) {
      const py = sy(yt)
      ctx.moveTo(pad.l, py)
      ctx.lineTo(pad.l + plotW, py)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    if (xMin < 0 && xMax > 0) {
      const zx = sx(0)
      ctx.beginPath()
      ctx.moveTo(zx, pad.t)
      ctx.lineTo(zx, pad.t + plotH)
      ctx.stroke()
    }
    if (yMin < 0 && yMax > 0) {
      const zy = sy(0)
      ctx.beginPath()
      ctx.moveTo(pad.l, zy)
      ctx.lineTo(pad.l + plotW, zy)
      ctx.stroke()
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(pad.l, pad.t, plotW, plotH)
    ctx.clip()

    data.series.forEach((ser, si) => {
      const color = GRAPH_COLORS[si % GRAPH_COLORS.length]
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false
      for (const p of ser.points || []) {
        if (p?.y == null || !Number.isFinite(p.y)) {
          started = false
          continue
        }
        const px = sx(p.x)
        const py = sy(p.y)
        if (!started) {
          ctx.moveTo(px, py)
          started = true
        } else {
          ctx.lineTo(px, py)
        }
      }
      ctx.stroke()
    })
    ctx.restore()

    ctx.strokeStyle = 'rgba(255,255,255,0.32)'
    ctx.lineWidth = 1
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, plotW - 1, plotH - 1)

    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const xt of xTicks) {
      const px = sx(xt)
      if (px >= pad.l - 4 && px <= pad.l + plotW + 4) {
        ctx.fillText(formatGraphTick(xt), px, pad.t + plotH + 6)
      }
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const yt of yTicks) {
      const py = sy(yt)
      if (py >= pad.t - 4 && py <= pad.t + plotH + 4) {
        ctx.fillText(formatGraphTick(yt), pad.l - 8, py)
      }
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = 'rgba(255,255,255,0.42)'
    ctx.fillText('x', pad.l + plotW / 2, h - 4)
  }, [data])

  useLayoutEffect(() => {
    redraw()
  }, [redraw])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => redraw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [redraw])

  if (!data?.series?.length) return null

  const legend = (data.expressions || data.series.map((s) => s.expression)).slice(0, 8)

  return (
    <div className="naowWidget naowWidget--graph" ref={wrapRef}>
      <div className="naowWidgetHead">Graph</div>
      <canvas ref={canvasRef} className="naowMathGraphCanvas" aria-label="Function plot" />
      <div className="naowMathGraphLegend" role="list">
        {legend.map((expr, i) => (
          <span key={`${expr}-${i}`} className="naowMathLegItem" role="listitem">
            <span className="naowMathLegSwatch" style={{ background: GRAPH_COLORS[i % GRAPH_COLORS.length] }} aria-hidden="true" />
            <code>{expr}</code>
          </span>
        ))}
      </div>
    </div>
  )
}

function formatStopwatchCentiseconds(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0)))
  const cs = Math.floor((total % 1000) / 10)
  const sec = Math.floor((total / 1000) % 60)
  const min = Math.floor((total / 60000) % 60)
  const hour = Math.floor(total / 3600000)
  const pad2 = (n) => String(n).padStart(2, '0')
  if (hour > 0) return `${hour}:${pad2(min)}:${pad2(sec)}.${pad2(cs)}`
  return `${pad2(min)}:${pad2(sec)}.${pad2(cs)}`
}

function formatTimerClock(remainingMs) {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function timerRemainingMs(timer, now) {
  if (!timer || timer.status === 'cancelled') return 0
  if (timer.status === 'paused') return Math.max(0, timer.pausedRemainingMs || 0)
  if (timer.status === 'active') return Math.max(0, timer.targetAt - now)
  return 0
}

function isLiveActivityChatCard(card) {
  const n = card?.name || card?.toolName || card?.action
  return [
    'timer_start',
    'timer_cancel',
    'timer_adjust',
    'timer_set',
    'timer_list',
    'timer_pause',
    'timer_resume',
    'stopwatch_start',
    'stopwatch_stop',
    'stopwatch_reset',
    'stopwatch_list',
  ].includes(n)
}

function IconPauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="liveActivityGlyph">
      <rect x="3" y="2" width="3.5" height="10" rx="1" fill="currentColor" />
      <rect x="7.5" y="2" width="3.5" height="10" rx="1" fill="currentColor" />
    </svg>
  )
}

function IconPlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="liveActivityGlyph">
      <path d="M4 2.5 L12 7 L4 11.5 Z" fill="currentColor" />
    </svg>
  )
}

function IconCloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="liveActivityGlyph">
      <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconResetGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="liveActivityGlyph liveActivityGlyph--reset">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12a9 9 0 1 0 3-6.7"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 4v6h6"
      />
    </svg>
  )
}

const MAX_LIVE_ACTIVITY = 5

function LiveActivityDock() {
  const timers = useStore((s) => s.timers)
  const stopwatches = useStore((s) => s.stopwatches)
  const applyClientToolAction = useStore((s) => s.applyClientToolAction)
  const [now, setNow] = useState(() => Date.now())
  const [dismissedStopwatches, setDismissedStopwatches] = useState(() => new Set())

  useEffect(() => {
    const needFast =
      timers.some((t) => t.status === 'active' || t.status === 'paused') ||
      stopwatches.some((w) => w.running)
    if (!needFast) return undefined
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [timers, stopwatches])

  const visibleTimers = timers.filter((t) => {
    if (t.status === 'cancelled') return false
    if (t.status === 'paused') return true
    if (t.status === 'active') return timerRemainingMs(t, now) > 0
    return false
  })

  const visibleStopwatches = stopwatches.filter((w) => !dismissedStopwatches.has(w.id))

  const shownTimers = visibleTimers.slice(0, MAX_LIVE_ACTIVITY)
  const remainingSlots = Math.max(0, MAX_LIVE_ACTIVITY - shownTimers.length)
  const shownStopwatches = visibleStopwatches.slice(0, remainingSlots)

  if (!shownTimers.length && !shownStopwatches.length) return null

  return (
    <div className="liveActivityDock" role="region" aria-label="Timers and stopwatches">
      {shownTimers.map((timer) => {
        const rem = timerRemainingMs(timer, now)
        const isPaused = timer.status === 'paused'
        const label = timer.label || 'Timer'
        return (
          <div key={timer.id} className="liveActivityPill liveActivityPill--timer">
            <div className="liveActivityControls">
              <button
                type="button"
                className="liveActivityBtn liveActivityBtn--primary"
                aria-label={isPaused ? 'Resume timer' : 'Pause timer'}
                onClick={() =>
                  applyClientToolAction({ action: isPaused ? 'timer_resume' : 'timer_pause', id: timer.id })
                }
              >
                {isPaused ? <IconPlayGlyph /> : <IconPauseGlyph />}
              </button>
              <button
                type="button"
                className="liveActivityBtn liveActivityBtn--ghost"
                aria-label="Cancel timer"
                onClick={() => applyClientToolAction({ action: 'timer_cancel', id: timer.id })}
              >
                <IconCloseGlyph />
              </button>
            </div>
            <div className="liveActivityReadout">
              <span className="liveActivityKind">{label}</span>
              <span className="liveActivityTime">{formatTimerClock(rem)}</span>
            </div>
          </div>
        )
      })}
      {shownStopwatches.map((watch) => {
        const elapsed = watch.running ? watch.elapsedMs + (now - watch.startedAt) : watch.elapsedMs
        const running = watch.running
        return (
          <div key={watch.id} className="liveActivityPill liveActivityPill--stopwatch">
            <div className="liveActivityControls">
              {running ? (
                <>
                  <button
                    type="button"
                    className="liveActivityBtn liveActivityBtn--primary"
                    aria-label="Pause stopwatch"
                    onClick={() => applyClientToolAction({ action: 'stopwatch_stop', id: watch.id })}
                  >
                    <IconPauseGlyph />
                  </button>
                  <button
                    type="button"
                    className="liveActivityBtn liveActivityBtn--ghost"
                    aria-label="Reset stopwatch"
                    onClick={() => applyClientToolAction({ action: 'stopwatch_reset', id: watch.id })}
                  >
                    <IconResetGlyph />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="liveActivityBtn liveActivityBtn--primary"
                    aria-label="Start stopwatch"
                    onClick={() =>
                      applyClientToolAction({
                        action: 'stopwatch_start',
                        id: watch.id,
                        label: watch.label || 'Stopwatch',
                      })
                    }
                  >
                    <IconPlayGlyph />
                  </button>
                  <button
                    type="button"
                    className="liveActivityBtn liveActivityBtn--ghost"
                    aria-label="Dismiss"
                    onClick={() =>
                      setDismissedStopwatches((prev) => new Set(prev).add(watch.id))
                    }
                  >
                    <IconCloseGlyph />
                  </button>
                </>
              )}
            </div>
            <div className="liveActivityReadout">
              <span className="liveActivityTime liveActivityTime--wide">{formatStopwatchCentiseconds(elapsed)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function formatCalculatorNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'Error'
  if (Number.isInteger(number)) return String(number)
  return String(Number(number.toPrecision(12)))
}

function computeCalculatorValue(left, operator, right) {
  const a = Number(left)
  const b = Number(right)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Error'
  if (operator === '+') return formatCalculatorNumber(a + b)
  if (operator === '-') return formatCalculatorNumber(a - b)
  if (operator === '*') return formatCalculatorNumber(a * b)
  if (operator === '/') return b === 0 ? 'Error' : formatCalculatorNumber(a / b)
  return formatCalculatorNumber(b)
}

function initialCalculatorState(calculator) {
  const result = String(calculator?.result ?? '0')
  return {
    display: result,
    expression: String(calculator?.expression || ''),
    stored: null,
    operator: null,
    waiting: true,
  }
}

function applyCalculatorKey(state, key) {
  if (key === 'C') return initialCalculatorState({ result: '0' })
  if (/^\d$/.test(key)) {
    const display = state.waiting || state.display === '0' || state.display === 'Error' ? key : `${state.display}${key}`
    return { ...state, display, waiting: false }
  }
  if (key === '.') {
    const display = state.waiting || state.display === 'Error'
      ? '0.'
      : state.display.includes('.') ? state.display : `${state.display}.`
    return { ...state, display, waiting: false }
  }
  if (key === '+/-') {
    const display = state.display.startsWith('-') ? state.display.slice(1) : `-${state.display}`
    return { ...state, display }
  }
  if (key === '%') {
    return { ...state, display: formatCalculatorNumber(Number(state.display) / 100), waiting: true }
  }
  if (['+', '-', '*', '/'].includes(key)) {
    const display = state.stored != null && state.operator && !state.waiting
      ? computeCalculatorValue(state.stored, state.operator, state.display)
      : state.display
    return {
      ...state,
      display,
      stored: display,
      operator: key,
      expression: `${display} ${key}`,
      waiting: true,
    }
  }
  if (key === '=') {
    if (!state.operator || state.stored == null) return { ...state, waiting: true }
    const display = computeCalculatorValue(state.stored, state.operator, state.display)
    return {
      ...state,
      display,
      expression: `${state.stored} ${state.operator} ${state.display}`,
      stored: null,
      operator: null,
      waiting: true,
    }
  }
  return state
}

function weatherEmojiFromCode(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return '🌤️'
  if (value === 0) return '☀️'
  if ([1, 2, 3].includes(value)) return '🌤️'
  if ([45, 48].includes(value)) return '🌫️'
  if ([51, 53, 55, 56, 57].includes(value)) return '🌦️'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return '🌧️'
  if ([71, 73, 75, 77, 85, 86].includes(value)) return '❄️'
  if ([95, 96, 99].includes(value)) return '⛈️'
  return '🌤️'
}

function formatWeekdayShort(isoDate) {
  if (!isoDate) return ''
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return String(isoDate).slice(0, 3)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] || ''
}

function formatHourShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric' })
}

function tempFromF(f, unit) {
  const n = Number(f)
  if (!Number.isFinite(n)) return null
  if (unit === 'C') return Math.round((n - 32) * (5 / 9))
  return Math.round(n)
}

function WeatherChatGptWidget({ weather }) {
  const fillGradientId = `wgrad-${useId().replace(/:/g, '')}`
  const [unit, setUnit] = useState('F')
  const [selectedDay, setSelectedDay] = useState(0)
  const daily = Array.isArray(weather?.daily) ? weather.daily : []
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly : []
  const current = weather?.current || {}
  const location = String(weather?.location || 'Weather').trim()

  const displayTemp = tempFromF(current.temperatureF, unit)
  const feels = tempFromF(current.feelsLikeF, unit)

  const chartPoints = useMemo(() => {
    if (!hourly.length) {
      return {
        line: '',
        area: '',
        labels: [],
        coords: [],
        minT: null,
        maxT: null,
        lo: null,
        hi: null,
        bands: [],
        yTicks: [],
      }
    }
    const temps = hourly.map((h) => Number(h.temperatureF)).filter((t) => Number.isFinite(t))
    if (!temps.length) {
      return {
        line: '',
        area: '',
        labels: [],
        coords: [],
        minT: null,
        maxT: null,
        lo: null,
        hi: null,
        bands: [],
        yTicks: [],
      }
    }
    const minT = Math.min(...temps)
    const maxT = Math.max(...temps)
    const pad = maxT - minT < 3 ? 2 : (maxT - minT) * 0.12
    const lo = minT - pad
    const hi = maxT + pad
    const w = 100
    const h = 100
    const span = Math.max(hi - lo, 1e-6)
    const tempToY = (t) => h - ((t - lo) / span) * (h - 8) - 4
    const denom = Math.max(1, hourly.length - 1)
    const coords = hourly.map((row, i) => {
      const x = (i / denom) * w
      const t = Number(row.temperatureF)
      const yn = Number.isFinite(t) ? tempToY(t) : h / 2
      return { x, y: yn, t, time: row.time }
    })
    const line = coords.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
    const area = `0,100 ${line} 100,100`
    const labels = coords.filter((_, i) => i % 3 === 0)

    const bandCount = 6
    const bands = []
    for (let i = 0; i < bandCount; i += 1) {
      const tLow = lo + (i / bandCount) * (hi - lo)
      const tHigh = lo + ((i + 1) / bandCount) * (hi - lo)
      const yTop = tempToY(tHigh)
      const yBot = tempToY(tLow)
      const height = Math.max(0.05, yBot - yTop)
      bands.push({ key: `b${i}`, y: yTop, height, alt: i % 2 === 1 })
    }

    const tickCount = 5
    const yTicks = []
    for (let i = 0; i < tickCount; i += 1) {
      const t = lo + (i / (tickCount - 1)) * (hi - lo)
      yTicks.push({ key: `y${i}`, tempF: t, y: tempToY(t) })
    }

    return { line, area, labels, coords, minT, maxT, lo, hi, bands, yTicks }
  }, [hourly])

  return (
    <div className="weatherChatgptCard">
      <div className="weatherChatgptHeader">
        <div className="weatherChatgptLocation">{location}</div>
        <div className="weatherChatgptHero">
          <div className="weatherChatgptTempBlock">
            <span className="weatherChatgptTemp">{displayTemp != null ? `${displayTemp}°` : '—'}</span>
            <div className="weatherChatgptUnitToggle" role="group" aria-label="Temperature unit">
              <button type="button" className={unit === 'F' ? 'isActive' : ''} onClick={() => setUnit('F')}>F</button>
              <span className="weatherChatgptUnitSep">/</span>
              <button type="button" className={unit === 'C' ? 'isActive' : ''} onClick={() => setUnit('C')}>C</button>
            </div>
          </div>
          <div className="weatherChatgptCondition">{current.summary || 'Current conditions'}</div>
        </div>
      </div>

      {daily.length > 0 && (
        <div className="weatherChatgptDaily" role="list">
          {daily.slice(0, 7).map((day, index) => (
            <button
              key={`${day.date}-${index}`}
              type="button"
              className={`weatherChatgptDay ${selectedDay === index ? 'isSelected' : ''}`}
              onClick={() => setSelectedDay(index)}
              role="listitem"
            >
              <span className="weatherChatgptDayName">{formatWeekdayShort(day.date)}</span>
              <span className="weatherChatgptDayIcon" aria-hidden="true">{weatherEmojiFromCode(day.weatherCode)}</span>
              <span className="weatherChatgptDayHigh">{tempFromF(day.highF, unit)}°</span>
              <span className="weatherChatgptDayLow">{tempFromF(day.lowF, unit)}°</span>
            </button>
          ))}
        </div>
      )}

      {hourly.length > 0 && chartPoints.line && (
        <div className="weatherChatgptChart">
          <div className="weatherChatgptChartHead">
            <div className="weatherChatgptChartLabel">Temperature</div>
            {chartPoints.minT != null && chartPoints.maxT != null && (
              <div className="weatherChatgptChartHiLo" aria-hidden="true">
                High {tempFromF(chartPoints.maxT, unit)}° · Low {tempFromF(chartPoints.minT, unit)}°
              </div>
            )}
          </div>
          <div className="weatherChatgptChartPlot">
            <div className="weatherChatgptYAxis" aria-hidden="true">
              {[...chartPoints.yTicks].reverse().map((tick) => {
                const v = tempFromF(tick.tempF, unit)
                const label = Number.isFinite(Number(v)) ? `${Math.round(Number(v))}°` : '—'
                return (
                  <span
                    key={tick.key}
                    className="weatherChatgptYTick"
                    style={{ top: `${tick.y}%` }}
                  >
                    {label}
                  </span>
                )
              })}
            </div>
            <svg className="weatherChatgptSvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(255, 149, 85, 0.35)" />
                  <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
                </linearGradient>
              </defs>
              {chartPoints.bands.map((band) => (
                <rect
                  key={band.key}
                  className={band.alt ? 'weatherChatgptBand weatherChatgptBand--alt' : 'weatherChatgptBand'}
                  x="0"
                  y={band.y}
                  width="100"
                  height={band.height}
                />
              ))}
              {chartPoints.yTicks.map((tick) => (
                <line
                  key={`grid-${tick.key}`}
                  className="weatherChatgptYGrid"
                  x1="0"
                  y1={tick.y}
                  x2="100"
                  y2={tick.y}
                />
              ))}
              <polygon className="weatherChatgptArea" points={chartPoints.area} fill={`url(#${fillGradientId})`} />
              <polyline className="weatherChatgptLine" fill="none" points={chartPoints.line} />
            </svg>
          </div>
          <div className="weatherChatgptAxis">
            {chartPoints.labels.map((p, i) => (
              <span key={`${p.time}-${i}`}>{formatHourShort(p.time)}</span>
            ))}
          </div>
        </div>
      )}

      <div className="weatherChatgptMeta">
        {feels != null && <span>Feels like {feels}°{unit}</span>}
        {Number.isFinite(Number(current.humidityPercent)) && <span>Humidity {Math.round(Number(current.humidityPercent))}%</span>}
        {Number.isFinite(Number(current.windMph)) && <span>Wind {Number(current.windMph).toFixed(1)} mph</span>}
      </div>
    </div>
  )
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

function isCalculatorCard(card) {
  return card?.name === 'calculate' || card?.toolName === 'calculate' || Boolean(card?.display?.calculator)
}

function rawToolCardsForMessage(message, toolCards = []) {
  return toolCards.length
    ? toolCards
    : (message?.toolCards || message?.metrics?.toolCards || message?.metadata?.metrics?.toolCards || message?.metrics?.toolActions || message?.metadata?.metrics?.toolActions || [])
}

function normalizedToolCardsForMessage(message, toolCards = []) {
  return rawToolCardsForMessage(message, toolCards).map(normalizeToolCard).filter(Boolean).slice(0, 8)
}

function getCalculatorCard({ message, toolCards = [] } = {}) {
  return normalizedToolCardsForMessage(message, toolCards).find(isCalculatorCard) || null
}

function fallbackToolTitle(card) {
  const name = card.name || card.toolName || card.action || 'Tool'
  return String(name).split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ')
}

function ToolCard({ card, now, messageAt }) {
  const upsertCalculator = useStore((s) => s.upsertCalculator)
  const display = card.display || {}
  const actionName = card.action || card.name || card.toolName
  const calculator = display.calculator || null
  const calculatorId = card.toolCallId || card.id || `${calculator?.expression || 'calculator'}:${calculator?.result || '0'}`
  const [calcState, setCalcState] = useState(() => initialCalculatorState(calculator))
  const [calculatorCopied, setCalculatorCopied] = useState(false)
  let title = display.title || fallbackToolTitle(card)
  let summary = display.summary || ''
  let status = card.status || ''
  let done = status === 'complete'

  useEffect(() => {
    if (!calculator) return
    setCalcState(initialCalculatorState(calculator))
  }, [calculatorId, calculator?.expression, calculator?.result])

  useEffect(() => {
    if (!calculator) return
    upsertCalculator(calculatorId, {
      expression: calcState.expression,
      result: calcState.display,
      source: 'calculator_card',
    })
  }, [calculator, calculatorId, calcState.expression, calcState.display, upsertCalculator])

  if (display.weather) {
    return (
      <div className={`messageToolCard weatherChatgptWrap ${done ? 'isDone' : ''} ${status === 'running' ? 'isRunning' : ''} ${status === 'error' ? 'isError' : ''}`}>
        <WeatherChatGptWidget weather={display.weather} />
        {card.error && status === 'error' && <span className="toolCardError">{card.error}</span>}
      </div>
    )
  }

  if (display.unitConversion) {
    return (
      <div className={`messageToolCard naowToolWrap ${done ? 'isDone' : ''}`}>
        <NaowUnitConversionWidget data={display.unitConversion} />
      </div>
    )
  }

  if (display.currencyConversion) {
    return (
      <div className={`messageToolCard naowToolWrap ${done ? 'isDone' : ''}`}>
        <NaowCurrencyWidget data={display.currencyConversion} />
      </div>
    )
  }

  if (display.worldClock?.rows?.length) {
    return (
      <div className={`messageToolCard naowToolWrap ${done ? 'isDone' : ''}`}>
        <NaowWorldClockWidget rows={display.worldClock.rows} />
      </div>
    )
  }

  if (display.sports) {
    return (
      <div className={`messageToolCard naowToolWrap ${done ? 'isDone' : ''}`}>
        <NaowSportsWidget data={display.sports} />
      </div>
    )
  }

  if (display.mathGraph?.series?.length) {
    return (
      <div className={`messageToolCard naowToolWrap ${done ? 'isDone' : ''}`}>
        <NaowMathGraphWidget data={display.mathGraph} />
      </div>
    )
  }

  const rows = Array.isArray(display.rows) ? display.rows.filter((row) => row?.label && row?.value != null) : []
  const links = Array.isArray(display.links) ? display.links.filter((link) => link?.url) : []
  const items = Array.isArray(display.items) ? display.items.filter(Boolean) : []

  if (actionName === 'calculate' || calculator) {
    const expression = calcState.expression || calculator?.expression || display.summary || ''
    const result = calcState.display || calculator?.result || calculator?.equation || '0'
    const keys = [
      ['C', 'utility'], ['+/-', 'utility'], ['%', 'utility'], ['/', 'operator'],
      ['7'], ['8'], ['9'], ['*', 'operator'],
      ['4'], ['5'], ['6'], ['-', 'operator'],
      ['1'], ['2'], ['3'], ['+', 'operator'],
      ['0', 'zero'], ['.'], ['=', 'equals']
    ]
    const press = (key) => setCalcState((current) => applyCalculatorKey(current, key))
    const copyResult = async () => {
      try {
        await navigator.clipboard.writeText(String(result))
        setCalculatorCopied(true)
        window.setTimeout(() => setCalculatorCopied(false), 1200)
      } catch {
        setCalculatorCopied(false)
      }
    }

    return (
      <div className={`messageToolCard calculatorToolCard ${done ? 'isDone' : ''}`}>
        <div className="calculatorScreen" aria-label={`Calculator result ${result}`}>
          <span className="calculatorExpression">{expression || 'Calculator'}</span>
          <strong>{result}</strong>
          <button type="button" className="calculatorCopyButton" onClick={copyResult} aria-label={calculatorCopied ? 'Copied result' : 'Copy calculator result'} title={calculatorCopied ? 'Copied' : 'Copy result'}>
            {calculatorCopied ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <div className="calculatorKeys">
          {keys.map(([key, type]) => (
            <button
              className={`calculatorKey ${type ? `is${type[0].toUpperCase()}${type.slice(1)}` : ''}`}
              key={key}
              onClick={() => press(key)}
              type="button"
            >
              {key}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const searchImages = Array.isArray(display.searchImages) ? display.searchImages : []

  return (
    <div className={`messageToolCard ${done ? 'isDone' : ''} ${status === 'running' ? 'isRunning' : ''} ${status === 'error' ? 'isError' : ''}`}>
      <div className="toolCardHeader">
        <strong>{title}</strong>
        {status && <span className="toolCardStatus">{status}</span>}
      </div>
      {summary && <span className="messageToolCardSummary">{summary}</span>}
      {searchImages.length > 0 && (
        <div className="searchImageGrid" role="group" aria-label="Related images">
          {searchImages.map((img, i) => (
            <figure key={`${img.url}-${i}`} className="searchImageCell">
              <img src={img.url} alt={img.title || 'Image'} loading="lazy" referrerPolicy="no-referrer" />
              {img.title && <figcaption>{img.title}</figcaption>}
            </figure>
          ))}
        </div>
      )}
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

function MessageToolCards({ message, toolCards = [], now, includeCalculators = false }) {
  const cards = normalizedToolCardsForMessage(message, toolCards)
    .filter((card) => includeCalculators || !isCalculatorCard(card))
    .filter((card) => !isLiveActivityChatCard(card))

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

function formatFindingWeatherLocation(raw) {
  const s = String(raw || '').trim()
  if (!s) return 'your area'
  const first = s.split(',')[0].trim()
  return first || s
}

function SearchingPlaceholder({ status }) {
  if (status?.phase === 'finding_weather') {
    const where = formatFindingWeatherLocation(status.location)
    return (
      <div className="searchingPlaceholder" role="status" aria-live="polite">
        <span className="searchingDots" aria-hidden="true"><span /><span /><span /></span>
        <span>{`Finding weather in ${where}`}</span>
      </div>
    )
  }
  const raw = String(status?.query || '').trim()
  const display = raw.length > 88 ? `${raw.slice(0, 88)}…` : raw
  const label = display ? `Searching: ${display}` : 'Searching…'
  return (
    <div className="searchingPlaceholder" role="status" aria-live="polite">
      <span className="searchingDots" aria-hidden="true"><span /><span /><span /></span>
      <span>{label}</span>
    </div>
  )
}

function AssistantMessageBody({ message, toolCards = [], now, content }) {
  const [calculatorOpen, setCalculatorOpen] = useState(false)
  const calculator = getCalculatorCard({ message, toolCards })
  return (
    <>
      <div className={calculator ? 'assistantContentLine hasCalculatorLauncher' : 'assistantContentLine'}>
        <MessageContent content={content ?? message?.content ?? message?.error ?? ''} />
        {calculator && (
          <button
            type="button"
            className="inlineCalculatorButton iconOnlyButton"
            onClick={() => setCalculatorOpen((value) => !value)}
            aria-label={calculatorOpen ? 'Close calculator' : 'Open calculator'}
            title={calculatorOpen ? 'Close calculator' : 'Open calculator'}
          >
            <IconCalculator />
          </button>
        )}
      </div>
      {calculatorOpen && <MessageToolCards message={message} toolCards={calculator ? [calculator] : []} now={now} includeCalculators />}
      <MessageToolCards message={message} toolCards={toolCards} now={now} />
    </>
  )
}

function IconMagnifyingGlass() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.2 15.2 20 20" />
    </svg>
  )
}

function IconNewChatHeader() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z" />
      <path d="M14 2v6h6" />
      <path d="M8 14h8M8 18h5" />
    </svg>
  )
}

function IconSettingsSliders() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 21v-7M4 10V3" />
      <path d="M12 21v-9M12 8V3" />
      <path d="M20 21v-5M20 12V3" />
      <circle cx="4" cy="14" r="2" />
      <circle cx="12" cy="11" r="2" />
      <circle cx="20" cy="16" r="2" />
    </svg>
  )
}

function IconShare() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 9 10 5 6 9" />
      <path d="M10 5v10" />
      <path d="M6 19h12" />
    </svg>
  )
}

function ChatSearchPanel({ chats, onSelect, onClose, autoFocus }) {
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState([])

  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [autoFocus])

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
    if (!needle) {
      return [...(chats || [])]
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, 14)
        .map((chat) => ({ chat, preview: chat.lastMessagePreview || chat.title || '' }))
    }
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
  }, [index, query, chats])

  return (
    <div className="chatSearchPanel">
      <label className="chatSearchPanelLabel" htmlFor="chat-search-input">Search chats</label>
      <div className="chatSearchPanelField">
        <IconMagnifyingGlass />
        <input
          id="chat-search-input"
          ref={inputRef}
          className="chatSearchPanelInput"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title or message…"
          autoComplete="off"
          aria-label="Search chats"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose?.()
            if (e.key === 'Enter' && results[0]) {
              onSelect(results[0].chat.id)
              setQuery('')
            }
          }}
        />
      </div>
      {results.length > 0 && (
        <div className="chatSearchPanelResults">
          {results.map((result, i) => (
            <button
              type="button"
              key={`${result.chat.id}-${i}`}
              className="chatSearchPanelHit"
              onClick={() => { onSelect(result.chat.id); setQuery('') }}
            >
              <span>{result.chat.title || 'Chat'}</span>
              <small>{result.preview}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatSearchOverlay({ open, onClose, chats, onSelectChat }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="chatSearchOverlay" role="dialog" aria-modal="true" aria-label="Search chats">
      <button type="button" className="chatSearchOverlayBackdrop" tabIndex={-1} aria-label="Close search" onClick={onClose} />
      <div className="chatSearchOverlayCard">
        <ChatSearchPanel
          chats={chats}
          autoFocus
          onClose={onClose}
          onSelect={(id) => {
            onSelectChat(id)
            onClose()
          }}
        />
      </div>
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
        if (!cancelled) setStatus({ status: 'unavailable', error: 'Backend offline.' })
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
  const downloadedBytes = (status?.models || []).reduce((sum, model) => sum + (model?.ready ? Number(model.sizeBytes ?? model.size ?? 0) : 0), 0)
  const downloadedText = downloadedBytes ? `Downloaded: ${formatBytes(downloadedBytes)}` : ''

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
      {downloadedText && <small>{downloadedText}</small>}
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

function Settings({ models, selectedModel, setSelectedModel, onUnloadModels, currentChatId }) {
  const [open, setOpen] = useState(false)
  const [renderPanel, setRenderPanel] = useState(false)
  const [closing, setClosing] = useState(false)
  const [unloadState, setUnloadState] = useState({ loading: false, message: '' })
  const [openSelect, setOpenSelect] = useState(null)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [systemPromptDraft, setSystemPromptDraft] = useState('')
  const [systemPromptBusy, setSystemPromptBusy] = useState(false)
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
  const [backendBusy, setBackendBusy] = useState(false)
  const [backendStatus, setBackendStatus] = useState({ online: true, message: '' })
  const setError = useStore((s) => s.setError)

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

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function pollBackend() {
      try {
        const result = await adapter.mlxPreflight?.()
        if (!cancelled) setBackendStatus({ online: Boolean(result?.ok), message: result?.message || '' })
      } catch (e) {
        if (!cancelled) setBackendStatus({ online: false, message: e?.message || 'Backend offline.' })
      }
    }
    pollBackend()
    const t = window.setInterval(pollBackend, 3000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [open])

  useEffect(() => {
    if (!open || !systemPromptOpen || !currentChatId) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const data = await adapter.loadChat(currentChatId)
        if (!cancelled) setSystemPromptDraft(String(data?.chat?.systemPrompt || ''))
      } catch {
        if (!cancelled) setSystemPromptDraft('')
      }
    })()
    return () => { cancelled = true }
  }, [open, systemPromptOpen, currentChatId])

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

  const startBackend = async () => {
    if (backendBusy) return
    setBackendBusy(true)
    try {
      await adapter.startMlxRunner?.()
      const result = await adapter.mlxPreflight?.()
      setBackendStatus({ online: Boolean(result?.ok), message: result?.message || '' })
    } catch (e) {
      setError(e?.message || 'Backend offline.')
    } finally {
      setBackendBusy(false)
    }
  }

  const stopBackend = async () => {
    if (backendBusy) return
    setBackendBusy(true)
    try {
      await adapter.stopMlxRunner?.()
      setBackendStatus({ online: false, message: 'Backend offline.' })
    } catch (e) {
      setError(e?.message || 'Stop failed.')
    } finally {
      setBackendBusy(false)
    }
  }

  return (
    <div className="settingsWrap" ref={wrapRef}>
      <button className="iconButton settingsButton" onClick={() => setOpen((v) => !v)} aria-label="Settings">
        <IconSettingsSliders />
      </button>
      {renderPanel && (
        <section className={`settingsPanel ${closing ? 'isClosing' : ''}`}>
          <div className="settingsTitle">Settings</div>
          <SelectControl id="theme" label="Theme" value={theme} onChange={setTheme} options={THEMES} {...selectProps} open={openSelect === 'theme'} />
          <SelectControl id="appearance" label="Appearance" value={colorMode} onChange={setColorMode} options={COLOR_MODES} {...selectProps} open={openSelect === 'appearance'} />
          <TextControl label="Name" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your name" />
          <SelectControl id="model" label="Model" value={selectedModel} onChange={setSelectedModel} options={modelOptions} {...selectProps} open={openSelect === 'model'} />
          <SettingsModelDownloads open={open} />
          <div className="settingsModelDownloads">
            <span className="settingsModelDownloadsTitle">Backend</span>
            <small>{backendStatus.online ? 'Online' : 'Offline'}{backendStatus.message ? ` · ${backendStatus.message}` : ''}</small>
            <div className="downloadChoices">
              <button type="button" onClick={startBackend} disabled={backendBusy || backendStatus.online}>Start</button>
              <button type="button" onClick={stopBackend} disabled={backendBusy || !backendStatus.online}>Stop</button>
            </div>
          </div>
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
          <div className="settingsModelDownloads">
            <span className="settingsModelDownloadsTitle">System prompt</span>
            <small>Applies to this chat. Models can update it via the `set_system_prompt` tool.</small>
            <div className="downloadChoices">
              <button type="button" onClick={() => setSystemPromptOpen((v) => !v)} disabled={!currentChatId}>
                {systemPromptOpen ? 'Close' : 'Edit'}
              </button>
              <button
                type="button"
                disabled={!currentChatId || systemPromptBusy}
                onClick={async () => {
                  if (!currentChatId || typeof adapter.setSystemPrompt !== 'function') return
                  setSystemPromptBusy(true)
                  try {
                    await adapter.setSystemPrompt(currentChatId, systemPromptDraft)
                  } catch (e) {
                    setError(e?.message || 'System prompt update failed.')
                  } finally {
                    setSystemPromptBusy(false)
                  }
                }}
              >
                {systemPromptBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {systemPromptOpen && (
              <textarea
                className="settingsSystemPrompt"
                value={systemPromptDraft}
                onChange={(e) => setSystemPromptDraft(e.target.value)}
                placeholder="System prompt for this chat…"
                rows={8}
              />
            )}
          </div>
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
          {String(attachment.mimeType || '').startsWith('image/') ? (
            <img src={attachment.url} alt={attachment.name || 'Attached image'} />
          ) : (
            <div className="messageAttachmentFile">
              <span>{attachment.name || 'file'}</span>
            </div>
          )}
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

function ChatCard({ chatId, active, messages, streamingContent, streamMetrics, streamSearchStatus, streamToolCards, isStreaming, now, wallNow, userName, onRegenerate, onEditUserMessage }) {
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
                <AssistantMessageBody message={message} now={wallNow} />
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
            {(streamSearchStatus?.phase === 'searching' || streamSearchStatus?.phase === 'finding_weather') && !streamingContent
              ? <SearchingPlaceholder status={streamSearchStatus} />
              : <AssistantMessageBody message={{ createdAt: new Date().toISOString(), content: streamingContent || ' ' }} toolCards={streamToolCards} now={wallNow} content={streamingContent || ' '} />}
            {!((streamSearchStatus?.phase === 'searching' || streamSearchStatus?.phase === 'finding_weather') && !streamingContent) && (
              <MessageMetrics metrics={streamMetrics} now={now} streaming />
            )}
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
        if (!cancelled) setStatus({ status: 'unavailable', error: 'Backend offline.' })
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

  const mlxNotReady = /backend offline/i.test(String(status?.error || ''))

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
        {mlxNotReady ? (
          <button
            onClick={() => {
              setBusy(true)
              adapter
                .startMlxRunner?.()
                .then(() => adapter.mlxModelsStatus?.().then((next) => setStatus(next)).catch(() => {}))
                .catch(() => setStatus((current) => ({ ...(current || {}), status: 'unavailable', error: 'Could not start the backend MLX runner.' })))
                .finally(() => setBusy(false))
            }}
            disabled={busy}
          >
            Start backend
          </button>
        ) : (
          <button onClick={() => adapter.openMlxModelsFolder().catch(() => {})}>Open folder</button>
        )}
        <button onClick={() => setDismissed(true)}>Dismiss</button>
      </div>
    </section>
  )
}

function ErrorToast() {
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const message = typeof error === 'string' ? error : (error?.message || '')
  const open = Boolean(message && String(message).trim())

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => setError(null), 5200)
    return () => window.clearTimeout(t)
  }, [open, setError])

  if (!open) return null

  return (
    <div className="errorToast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
    </div>
  )
}

function DeepResearchDoneToast({ onOpenChat }) {
  const toast = useStore((s) => s.deepResearchDoneToast)
  const setToast = useStore((s) => s.setDeepResearchDoneToast)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 8200)
    return () => window.clearTimeout(t)
  }, [toast, setToast])

  if (!toast?.slug) return null

  return (
    <div className="deepResearchToast" role="status" aria-live="polite">
      <span>Deep research finished{toast.topic ? `: ${toast.topic}` : ''}</span>
      <button
        type="button"
        className="deepResearchToastPrimary"
        onClick={() => {
          onOpenChat(toast.slug)
          setToast(null)
        }}
      >
        Open chat
      </button>
      <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
    </div>
  )
}

function BackendOfflineToast({ backendPhase, onStart }) {
  if (backendPhase === 'online') return null
  const starting = backendPhase === 'starting'
  return (
    <div className="backendOfflineToast" role="status" aria-live="polite">
      <div>
        <strong>Backend offline</strong>
        <span>Start the backend to send messages.</span>
      </div>
      <button type="button" onClick={onStart} disabled={starting}>{starting ? 'Starting…' : 'Start backend'}</button>
    </div>
  )
}

export default function App() {
  const theme = useStore((s) => s.theme)
  const colorMode = useStore((s) => s.colorMode)
  const userName = useStore((s) => s.userName).trim()
  const setError = useStore((s) => s.setError)
  const {
    models, selectedModel, setSelectedModel,
    chats, currentChatId, messages, streamingContent, isStreaming, streamMetrics, streamSearchStatus, queuedMessages,
    streamToolCards,
    input, setInput, pendingAttachments, loadModels, loadChats, selectChat, newChat, unloadModels, sendMessage, stopGeneration, regenerate, editUserMessage, handleKeyDown,
  } = useChat()
  const addPendingAttachments = useStore((s) => s.addPendingAttachments)
  const removePendingAttachment = useStore((s) => s.removePendingAttachment)
  const messagesByChat = useStore((s) => s.messagesByChat)
  const hasLiveToolClock = useStore((s) => (
    s.timers.some((timer) => timer.status === 'active' || timer.status === 'paused') ||
    s.stopwatches.some((watch) => watch.running)
  ))
  const [now, setNow] = useState(() => performance.now())
  const [wallNow, setWallNow] = useState(() => Date.now())
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareStatus, setShareStatus] = useState('')
  const shareWrapRef = useRef(null)
  const [backendPhase, setBackendPhase] = useState('online')
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const bootstrappedRef = useRef(false)
  const [composerMode, setComposerMode] = useState('chat') // 'chat' | 'deep_research'
  const [drWatchIds, setDrWatchIds] = useState([])
  const [drStatusByChat, setDrStatusByChat] = useState({})
  const drPrevPhaseRef = useRef({})
  const [drRetryUntil, setDrRetryUntil] = useState(null)
  const [drNowTick, setDrNowTick] = useState(() => Date.now())
  const [globalDropActive, setGlobalDropActive] = useState(false)
  const globalDropDepthRef = useRef(0)

  useEffect(() => {
    setError(null)
    const st = useStore.getState()
    st.clearToolActivities()
    st.clearStreamToolCards()
    st.clearQueuedMessages()
    st.setCurrentPreSearchId(null)
  }, [setError])

  useEffect(() => {
    if (bootstrappedRef.current) return
    bootstrappedRef.current = true
    async function bootstrap() {
      try {
        await loadModels()
        const loaded = await loadChats()
        const pathMatch = typeof window !== 'undefined' && window.location.pathname.match(/^\/chat\/([a-z]{5})\/?$/)
        if (pathMatch) {
          await selectChat(pathMatch[1])
          return
        }
        const ordered = orderChats(loaded)
        const reusable = [...ordered].reverse().find((chat) => {
          const cachedMessages = useStore.getState().messagesByChat[chat.id]
          const knownEmpty = chat.messageCount === 0 || cachedMessages?.length === 0
          const looksUntitled = !chat.title || /^new chat$/i.test(chat.title)
          return knownEmpty && looksUntitled
        })
        if (reusable) selectChat(reusable.id)
        else newChat()
      } catch (error) {
        setError(String(error?.message || error || 'Backend is offline.'))
      }
    }
    bootstrap()
  }, [])

  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/chat\/([a-z]{5})\/?$/)
      if (m) void selectChat(m[1])
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [selectChat])

  useEffect(() => {
    if (!currentChatId) return undefined
    let cancelled = false
    ;(async () => {
      try {
        if (typeof adapter.getDeepResearch !== 'function') return
        const st = await adapter.getDeepResearch(currentChatId)
        if (cancelled) return
        setDrStatusByChat((prev) => ({ ...prev, [currentChatId]: st }))
        if (st?.phase === 'running') {
          drPrevPhaseRef.current[currentChatId] = st.phase
          setDrWatchIds((ids) => (ids.includes(currentChatId) ? ids : [...ids, currentChatId]))
        }
      } catch {
        /* optional endpoint */
      }
    })()
    return () => { cancelled = true }
  }, [currentChatId])

  useEffect(() => {
    if (drWatchIds.length === 0) return undefined
    let cancelled = false
    const tick = async () => {
      const ids = [...drWatchIds]
      for (const id of ids) {
        try {
          if (typeof adapter.getDeepResearch !== 'function') return
          const st = await adapter.getDeepResearch(id)
          if (cancelled) return
          setDrStatusByChat((prev) => ({ ...prev, [id]: st }))
          const prev = drPrevPhaseRef.current[id] ?? 'idle'
          const phase = st.phase || 'idle'
          if (prev === 'running' && phase === 'complete') {
            const cur = useStore.getState().currentChatId
            if (cur !== id) {
              const chat = useStore.getState().chats.find((c) => c.id === id)
              if (chat?.slug) {
                useStore.getState().setDeepResearchDoneToast({ slug: chat.slug, topic: st.topic || 'Deep research' })
              }
            }
          }
          drPrevPhaseRef.current[id] = phase
          if (['complete', 'stopped', 'error'].includes(phase)) {
            try {
              const { messages: ms } = await adapter.loadChat(id)
              useStore.getState().setMessagesForChat(id, ms ?? [])
            } catch {
              /* ignore */
            }
            loadChats().catch(() => {})
            setDrWatchIds((list) => list.filter((x) => x !== id))
          }
        } catch {
          if (!cancelled) {
            setDrStatusByChat((prev) => ({ ...prev, [id]: { phase: 'error', error: 'status_failed' } }))
          }
        }
      }
    }
    tick()
    const iv = window.setInterval(tick, 2500)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
  }, [drWatchIds.join(','), loadChats])

  const drStatus = drStatusByChat[currentChatId] || { phase: 'idle' }
  useEffect(() => {
    if (drStatus?.nextRetryInMs) {
      setDrRetryUntil(Date.now() + drStatus.nextRetryInMs)
    } else {
      setDrRetryUntil(null)
    }
  }, [currentChatId, drStatus?.nextRetryInMs, drStatus?.updatedAt])

  useEffect(() => {
    if (!drRetryUntil) return undefined
    const iv = window.setInterval(() => setDrNowTick(Date.now()), 400)
    return () => window.clearInterval(iv)
  }, [drRetryUntil])

  const drRetrySecs = drRetryUntil ? Math.max(0, Math.ceil((drRetryUntil - drNowTick) / 1000)) : null

  const startDeepResearch = useCallback(async (topicRaw) => {
    const topic = String(topicRaw || '').trim()
    if (!topic || !currentChatId) return false
    if (typeof adapter.startDeepResearch !== 'function') {
      setError('Deep research is not available.')
      return false
    }
    try {
      await adapter.startDeepResearch(currentChatId, topic)
      drPrevPhaseRef.current[currentChatId] = 'idle'
      setDrStatusByChat((prev) => ({ ...prev, [currentChatId]: { ...prev[currentChatId], phase: 'running', topic } }))
      setDrWatchIds((ids) => (ids.includes(currentChatId) ? ids : [...ids, currentChatId]))
      return true
    } catch (e) {
      setError(e?.message || String(e))
      return false
    }
  }, [currentChatId, setError])

  const stopDeepResearch = useCallback(async () => {
    if (!currentChatId || typeof adapter.stopDeepResearch !== 'function') return
    try {
      await adapter.stopDeepResearch(currentChatId)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [currentChatId, setError])

  const retryDeepResearch = useCallback(async () => {
    if (!currentChatId || typeof adapter.retryDeepResearch !== 'function') return
    try {
      await adapter.retryDeepResearch(currentChatId)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [currentChatId, setError])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const result = await adapter.mlxPreflight?.()
        if (cancelled) return
        setBackendPhase(Boolean(result?.ok) ? 'online' : 'offline')
      } catch {
        if (!cancelled) setBackendPhase('offline')
      }
    }
    poll()
    const t = window.setInterval(poll, 2500)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [])

  const startBackend = useCallback(async () => {
    try {
      setBackendPhase('starting')
      await adapter.startMlxRunner?.()
      const result = await adapter.mlxPreflight?.()
      setBackendPhase(Boolean(result?.ok) ? 'online' : 'offline')
      if (!result?.ok) setError(result?.message || 'Backend offline.')
    } catch (e) {
      setBackendPhase('offline')
      setError(e?.message || 'Backend offline.')
    }
  }, [setError])

  useEffect(() => {
    const onUnhandledRejection = (event) => {
      const msg = event?.reason?.message || String(event?.reason || '')
      if (msg) setError(msg)
    }
    const onWindowError = (event) => {
      const msg = event?.error?.message || event?.message
      if (msg) setError(String(msg))
    }
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    window.addEventListener('error', onWindowError)
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      window.removeEventListener('error', onWindowError)
    }
  }, [setError])

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

  useEffect(() => {
    const isAllowed = (file) => {
      if (!file) return false
      if (file.size > 100 * 1024 * 1024) return false
      const name = String(file.name || '')
      const extOk = /\.(txt|md|json|ya?ml|toml|ini|env|js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|hpp|css|html|sh|bash|zsh|xml|csv|tsv|log)$/i.test(name)
      const typeOk = String(file.type || '').startsWith('text/')
        || String(file.type || '').startsWith('image/')
        || String(file.type || '').includes('json')
      return extOk || typeOk
    }

    const hasFiles = (dt) => Array.from(dt?.types || []).includes('Files')
    const onDragEnter = (e) => {
      if (!hasFiles(e.dataTransfer)) return
      globalDropDepthRef.current += 1
      setGlobalDropActive(true)
      e.preventDefault()
    }
    const onDragOver = (e) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
    }
    const onDragLeave = (e) => {
      if (!hasFiles(e.dataTransfer)) return
      globalDropDepthRef.current = Math.max(0, globalDropDepthRef.current - 1)
      if (globalDropDepthRef.current === 0) setGlobalDropActive(false)
      e.preventDefault()
    }
    const onDrop = (e) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      globalDropDepthRef.current = 0
      setGlobalDropActive(false)
      const files = Array.from(e.dataTransfer?.files || []).filter(isAllowed)
      if (files.length) addPendingAttachments(files)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addPendingAttachments])

  useEffect(() => {
    const onPaletteShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'f')) {
        event.preventDefault()
        setChatSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onPaletteShortcut)
    return () => window.removeEventListener('keydown', onPaletteShortcut)
  }, [])

  useEffect(() => {
    if (!shareOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setShareOpen(false)
    }
    const onOutside = (e) => {
      if (!shareWrapRef.current?.contains(e.target)) setShareOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onOutside, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onOutside, true)
    }
  }, [shareOpen])

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

  const copyChatLink = async () => {
    const slug = currentChat?.slug
    if (!slug) return
    const url = `${window.location.origin}/chat/${slug}`
    try {
      await navigator.clipboard.writeText(url)
      setShareStatus('Link copied.')
      window.setTimeout(() => setShareStatus(''), 1600)
    } catch {
      setShareStatus('Copy failed.')
      window.setTimeout(() => setShareStatus(''), 1600)
    }
  }

  const exportChatJson = async () => {
    if (!currentChatId) return
    try {
      const data = await adapter.loadChat(currentChatId)
      const payload = { chat: data.chat, messages: data.messages }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      const slug = data?.chat?.slug || 'chat'
      a.href = URL.createObjectURL(blob)
      a.download = `naow-${slug}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      setShareStatus('Exported.')
      window.setTimeout(() => setShareStatus(''), 1600)
    } catch (e) {
      setError(e?.message || 'Export failed.')
    }
  }


  const resolvedColorMode = colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode

  useEffect(() => {
    const background = resolvedColorMode === 'dark' ? '#101113' : '#fbfaf7'
    document.documentElement.style.backgroundColor = background
    document.body.style.backgroundColor = background
    document.documentElement.dataset.naowColorMode = resolvedColorMode
  }, [resolvedColorMode])

  const currentQueue = queuedMessages.filter((message) => message.chatId === currentChatId)
  const hasDraft = input.trim() || pendingAttachments.length > 0
  const actionLabel = composerMode === 'deep_research'
    ? 'Deep research'
    : (isStreaming ? (hasDraft ? 'Queue' : 'Send') : 'Send')

  const handleComposerAction = async () => {
    if (composerMode === 'deep_research') {
      const ok = await startDeepResearch(input)
      if (ok) {
        setInput('')
        setComposerMode('chat')
      }
      return
    }
    sendMessage()
  }

  const addFiles = (files) => {
    const isAllowed = (file) => {
      if (!file) return false
      if (file.size > 100 * 1024 * 1024) return false
      const name = String(file.name || '')
      const extOk = /\.(txt|md|json|ya?ml|toml|ini|env|js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|hpp|css|html|sh|bash|zsh|xml|csv|tsv|log)$/i.test(name)
      const typeOk = String(file.type || '').startsWith('text/')
        || String(file.type || '').startsWith('image/')
        || String(file.type || '').includes('json')
      return extOk || typeOk
    }
    const next = Array.from(files || []).filter(isAllowed)
    if (next.length) addPendingAttachments(next)
  }

  return (
    <div className={`app theme-${theme} color-${resolvedColorMode} ${globalDropActive ? 'isGlobalDropping' : ''}`}>
      <div className="themeFade" aria-hidden="true" />
      <ErrorToast />
      <DeepResearchDoneToast onOpenChat={(slug) => void selectChat(slug)} />
      <div className="topRightHud">
        <BackendOfflineToast backendPhase={backendPhase} onStart={startBackend} />
        <LiveActivityDock />
      </div>
      <header className="topBar">
        <div className="topBarInner">
          <div className="topBarSpacer" aria-hidden="true" />
          <button type="button" className="brandButton" onClick={() => openNewThread()}>naow</button>
          <div className="topBarTools">
            <button type="button" className="iconOnlyButton topBarToolButton" onClick={() => setChatSearchOpen(true)} aria-label="Search chats" title="Search chats (⌘K)">
              <IconMagnifyingGlass />
            </button>
            <div className="shareMenuWrap" ref={shareWrapRef}>
              <button
                type="button"
                className="iconOnlyButton topBarToolButton"
                onClick={() => setShareOpen((v) => !v)}
                aria-label="Share or export"
                title="Share or export"
              >
                <IconShare />
              </button>
              {shareOpen && (
                <div className="shareMenuCard" role="dialog" aria-label="Share or export">
                  <button type="button" onClick={() => void copyChatLink()} disabled={!currentChat?.slug}>Share (copy link)</button>
                  <button type="button" onClick={() => void exportChatJson()} disabled={!currentChatId}>Export JSON</button>
                  {shareStatus ? <small>{shareStatus}</small> : null}
                </div>
              )}
            </div>
            <Settings models={models} selectedModel={selectedModel} setSelectedModel={setSelectedModel} onUnloadModels={unloadModels} currentChatId={currentChatId} />
          </div>
        </div>
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
            streamSearchStatus={streamSearchStatus}
            streamToolCards={streamToolCards}
            isStreaming={isStreaming}
            now={now}
            wallNow={wallNow}
            userName={userName}
            onRegenerate={regenerate}
            onEditUserMessage={editUserMessage}
          />
        </div>
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
                {String(attachment.mimeType || '').startsWith('image/') ? (
                  <img src={attachment.previewUrl} alt={attachment.name} />
                ) : (
                  <div className="attachmentFileIcon" aria-hidden="true">
                    {(attachment.name || 'file').split('.').pop()?.slice(0, 4)?.toUpperCase() || 'FILE'}
                  </div>
                )}
                <span>{attachment.name}</span>
                <button onClick={() => removePendingAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>×</button>
              </div>
            ))}
          </div>
        )}
        {currentChatId && drStatus.phase === 'running' && (
          <div className="deepResearchInline" role="status" aria-live="polite">
            <span className="deepResearchInlineTitle">
              Deep research
              {Array.isArray(drStatus.goals) && drStatus.goals.length > 0
                ? ` · Goal ${(drStatus.currentGoalIndex ?? 0) + 1}/${drStatus.goals.length}`
                : ''}
              {typeof drStatus.searchesThisGoal === 'number' ? ` · ${drStatus.searchesThisGoal}/200` : ''}
            </span>
            {drStatus.pausedMessage && (
              <>
                <span className="deepResearchInlinePause">
                  {drStatus.pausedMessage}{drRetrySecs != null ? ` · ${drRetrySecs}s` : ''}
                </span>
                <button type="button" className="deepResearchRetry" onClick={() => void retryDeepResearch()}>Retry now</button>
              </>
            )}
            <button type="button" className="deepResearchStop" onClick={() => void stopDeepResearch()}>Stop</button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="text/*,application/json,application/x-yaml,.md,.txt,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cc,.cpp,.h,.hpp,.css,.html,.sh,.bash,.zsh,.yaml,.yml,.toml,.ini,.env,image/*"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files)
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
            addFiles(event.dataTransfer.files)
          }}
        >
          <button className="attachButton" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach file">+</button>
          <button
            type="button"
            className={`researchButton iconOnlyButton ${composerMode === 'deep_research' ? 'isActive' : ''}`}
            onClick={() => setComposerMode((m) => (m === 'deep_research' ? 'chat' : 'deep_research'))}
            aria-label="Deep research"
          >
            <IconSources />
            <span className="vibeTooltip" role="tooltip">Deep research</span>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (composerMode === 'deep_research' && e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleComposerAction()
                return
              }
              handleKeyDown(e)
            }}
            onPaste={(event) => addFiles(event.clipboardData?.files)}
            disabled={!currentChat}
            placeholder={composerMode === 'deep_research' ? 'Deep research topic…' : (isStreaming ? 'Queue the next message' : 'Message naow')}
            rows={1}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 138)}px` }}
          />
          <div className="composerActions">
            {isStreaming && (
              <button
                type="button"
                className="stopButton"
                onClick={stopGeneration}
                aria-label="Stop"
                title="Stop"
              >
                <IconStopComposer />
              </button>
            )}
            <button
              type="button"
              className="sendButton"
              onClick={handleComposerAction}
              aria-label={actionLabel}
              title={actionLabel}
            >
              {composerMode === 'deep_research' ? <IconSend /> : (isStreaming ? <IconQueueComposer /> : <IconSend />)}
            </button>
          </div>
        </div>
        <BackendStats selectedModel={selectedModel} active={isStreaming} backendPhase={backendPhase} />
      </footer>
      <ChatSearchOverlay
        open={chatSearchOpen}
        onClose={() => setChatSearchOpen(false)}
        chats={orderedChats}
        onSelectChat={selectChat}
      />
    </div>
  )
}
