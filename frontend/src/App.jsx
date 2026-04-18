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
      `total ${formatMetric(metrics.generationMs)}`,
    ]
    if (Number(metrics.webSearchMs) > 0) parts.push(`search ${formatMetric(metrics.webSearchMs)}`)
    return parts.join(' · ')
  }
  const end = streaming ? now : (metrics.updatedAt || now)
  const elapsed = Math.max((end - metrics.startedAt) / 1000, 0.001)
  const rate = metrics.tokens ? (metrics.tokens / elapsed).toFixed(1) : '--'
  const ttft = metrics.firstTokenAt ? formatMetric(metrics.firstTokenAt - metrics.startedAt) : 'waiting'
  return `${rate} tok/s · first token ${ttft}`
}

function MessageMetrics({ metrics, now, streaming }) {
  const showMetrics = useStore((s) => s.showMetrics)
  if (!showMetrics || !metrics) return null
  const sources = Array.isArray(metrics.sources) ? metrics.sources.filter((source) => source?.url).slice(0, 5) : []
  return (
    <div className="messageMetrics">
      <span>{metricsText(metrics, now, streaming)}</span>
      {sources.length > 0 && (
        <span className="messageSources">
          {' · sources '}
          {sources.map((source, index) => (
            <React.Fragment key={`${source.url}-${index}`}>
              {index > 0 ? ', ' : ''}
              <a href={source.url} target="_blank" rel="noreferrer">{index + 1}</a>
            </React.Fragment>
          ))}
        </span>
      )}
    </div>
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

  const backend = stats?.backend?.label || '--'
  const cpu = formatPercent(cpuDisplayValue)
  const ram = formatBytes(stats?.ram?.rssBytes)
  const gpu = stats?.gpu?.available ? formatPercent(stats.gpu.usagePercent) : '--'

  return (
    <div className="backendStats" aria-live="polite">
      <span className="statItem"><strong>Backend</strong> <span className="backendValue">{backend}</span></span>
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

function ToolShelf({ now }) {
  const timers = useStore((s) => s.timers)
  const stopwatches = useStore((s) => s.stopwatches)
  const activities = useStore((s) => s.toolActivities)
  const activeTimers = timers.filter((timer) => timer.status === 'active').slice(-3)
  const activeStopwatches = stopwatches.filter((watch) => watch.running).slice(-3)
  const recent = activities.slice(0, 2)
  if (!activeTimers.length && !activeStopwatches.length && !recent.length) return null

  return (
    <div className="toolShelf" aria-live="polite">
      {activeTimers.map((timer) => {
        const remaining = timer.targetAt - now
        const done = remaining <= 0
        return (
          <div className={`toolChip ${done ? 'isDone' : ''}`} key={timer.id}>
            <strong>{done ? 'Timer done' : timer.label}</strong>
            <span>{done ? 'Ready' : formatDuration(remaining)}</span>
          </div>
        )
      })}
      {activeStopwatches.map((watch) => (
        <div className="toolChip" key={watch.id}>
          <strong>{watch.label}</strong>
          <span>{formatDuration(watch.elapsedMs + now - watch.startedAt)}</span>
        </div>
      ))}
      {recent.map((activity) => (
        <div className="toolChip isActivity" key={activity.id}>
          <strong>{activity.event === 'web_search' ? 'web search' : activity.name || activity.event || 'Tool'}</strong>
          <span>
            {activity.event === 'web_search'
              ? activity.used ? `read ${activity.fetchedCount || 0}` : activity.skipped || 'skipped'
              : activity.event === 'tool_call_error' ? 'failed' : activity.event === 'tool_call_result' ? 'done' : 'running'}
          </span>
        </div>
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
      <button className="iconButton" onClick={() => setOpen((v) => !v)} aria-label="Settings">Settings</button>
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
          <section key={message.id} className={`message ${message.role} ${message.status === 'error' ? 'isError' : ''}`}>
            <AttachmentStrip attachments={message.attachments} />
            <MessageContent content={message.content || message.error || ''} />
            {message.role === 'assistant' && <MessageMetrics metrics={message.metrics} now={now} />}
          </section>
        ))}
        {active && isStreaming && (
          <section className="message assistant isStreaming">
            <MessageContent content={streamingContent || ' '} />
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
    input, setInput, pendingAttachments, loadModels, loadChats, selectChat, newChat, unloadModels, sendMessage, stopGeneration, handleKeyDown,
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

  const moveTo = (index) => {
    const next = orderedChats[Math.max(0, Math.min(orderedChats.length - 1, index))]
    if (next && next.id !== currentChatId) selectChat(next.id)
  }

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
            isStreaming={isStreaming}
            now={now}
            userName={userName}
          />
        </div>
        <button className="newThreadButton" onClick={() => openNewThread()} aria-label="New thread">
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
        <BackendStats selectedModel={selectedModel} active={isStreaming} />
        <ToolShelf now={wallNow} />
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
            placeholder={isStreaming ? 'Queue the next message' : (userName ? `Message naow, ${userName}` : 'Message naow')}
            rows={1}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 138)}px` }}
          />
          <div className="composerActions">
            <button className="sendButton" onClick={handleComposerAction}>{actionLabel}</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
