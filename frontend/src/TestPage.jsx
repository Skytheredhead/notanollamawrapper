import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import adapter from './adapter'
import useStore from './store'

const CONTEXT_LENGTHS = [16, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]

function mean(values) {
  const nums = (values || []).map((v) => Number(v)).filter((v) => Number.isFinite(v))
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 750)
}

function useLocalStorageState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return initialValue
      return JSON.parse(raw)
    } catch {
      return initialValue
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch { /* ignore */ }
  }, [key, value])
  return [value, setValue]
}

async function runSingleTurn({ chatId, model, numCtx, text, abortSignal }) {
  return await new Promise((resolve, reject) => {
    let firstTokenPerfAt = null
    const startedPerfAt = performance.now()

    const ctrl = adapter.sendMessage(
      chatId,
      text,
      model,
      {
        num_ctx: numCtx,
        max_tokens: 32,
        num_predict: 32,
        naow_disable_prompt_cache_warm: true,
        residency: useStore.getState().modelResidency || 'always_hot',
      },
      false,
      [],
      () => {
        if (firstTokenPerfAt == null) firstTokenPerfAt = performance.now()
      },
      (result) => {
        const serverFirstTokenMs = result?.message?.metrics?.firstTokenMs
          ?? result?.message?.metadata?.metrics?.firstTokenMs
          ?? null
        const clientFirstTokenMs = firstTokenPerfAt == null ? null : Math.max(0, firstTokenPerfAt - startedPerfAt)
        resolve({
          result,
          metrics: {
            serverFirstTokenMs: Number.isFinite(serverFirstTokenMs) ? serverFirstTokenMs : null,
            clientFirstTokenMs: Number.isFinite(clientFirstTokenMs) ? clientFirstTokenMs : null,
          },
        })
      },
      (err) => reject(err),
      { enabled: false },
      null,
      null,
      'normal'
    )

    if (abortSignal) {
      const onAbort = () => {
        try { ctrl?.abort?.() } catch { /* ignore */ }
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (abortSignal.aborted) onAbort()
      else abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function svgPath(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
  if (!pts.length) return ''
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
}

function MiniLineChart({ rows }) {
  const data = (rows || []).filter((r) => Number.isFinite(r?.firstTtftMs) || Number.isFinite(r?.avgNextTtftMs))
  const xLabels = data.map((r) => String(r.ctx))

  const firstVals = data.map((r) => r.firstTtftMs).filter((v) => Number.isFinite(v))
  const nextVals = data.map((r) => r.avgNextTtftMs).filter((v) => Number.isFinite(v))
  const allVals = [...firstVals, ...nextVals]
  const minY = allVals.length ? Math.max(0, Math.min(...allVals) * 0.9) : 0
  const maxY = allVals.length ? Math.max(...allVals) * 1.1 : 1

  const w = 920
  const h = 320
  const padL = 52
  const padR = 18
  const padT = 16
  const padB = 44

  const innerW = w - padL - padR
  const innerH = h - padT - padB
  const n = Math.max(1, data.length)

  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yAt = (v) => {
    if (!Number.isFinite(v)) return null
    const t = (v - minY) / Math.max(1e-9, (maxY - minY))
    return padT + (1 - clamp(t, 0, 1)) * innerH
  }

  const firstPts = data.map((r, i) => ({ x: xAt(i), y: yAt(r.firstTtftMs) })).filter((p) => p.y != null)
  const nextPts = data.map((r, i) => ({ x: xAt(i), y: yAt(r.avgNextTtftMs) })).filter((p) => p.y != null)

  const gridLines = 4
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => i)

  return (
    <div className="ttftChartWrap">
      <svg className="ttftChart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="TTFT by context length">
        <rect x="0" y="0" width={w} height={h} fill="transparent" />

        {ticks.map((i) => {
          const y = padT + (i / gridLines) * innerH
          const v = maxY - (i / gridLines) * (maxY - minY)
          return (
            <g key={`g${i}`}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 10} y={y + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                {Number.isFinite(v) ? `${Math.round(v)}ms` : ''}
              </text>
            </g>
          )
        })}

        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="var(--line)" strokeWidth="1" />
        <line x1={padL} y1={padT + innerH} x2={w - padR} y2={padT + innerH} stroke="var(--line)" strokeWidth="1" />

        <path d={svgPath(nextPts)} fill="none" stroke="rgba(45, 125, 245, 0.92)" strokeWidth="2.5" />
        <path d={svgPath(firstPts)} fill="none" stroke="rgba(17, 17, 17, 0.95)" strokeWidth="2.5" />

        {nextPts.map((p, idx) => (
          <circle key={`n${idx}`} cx={p.x} cy={p.y} r="3.2" fill="rgba(45, 125, 245, 0.92)" />
        ))}
        {firstPts.map((p, idx) => (
          <circle key={`f${idx}`} cx={p.x} cy={p.y} r="3.2" fill="rgba(17, 17, 17, 0.95)" />
        ))}

        {xLabels.map((label, i) => (
          <text key={`x${label}`} x={xAt(i)} y={h - 18} textAnchor="middle" fontSize="11" fill="var(--muted)">
            {label}
          </text>
        ))}
      </svg>

      <div className="ttftLegend">
        <span className="ttftLegendItem">
          <span className="swatch swatchFirst" aria-hidden="true" /> first TTFT
        </span>
        <span className="ttftLegendItem">
          <span className="swatch swatchNext" aria-hidden="true" /> avg next 4 TTFT
        </span>
      </div>
    </div>
  )
}

export default function TestPage() {
  const selectedModel = useStore((s) => s.selectedModel)
  const residency = useStore((s) => s.modelResidency)
  const [models, setModels] = useState([])
  const [model, setModel] = useState(selectedModel || '')
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const abortRef = useRef(null)

  const storageKey = useMemo(() => `naow_ttft_runs_v1`, [])
  const [runs, setRuns] = useLocalStorageState(storageKey, [])

  const latestRun = runs?.[0] || null
  const rows = latestRun?.rows || []

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ms = await adapter.listModels()
        if (cancelled) return
        setModels(ms)
        const fallback = ms?.[0] || ''
        setModel((cur) => cur || selectedModel || fallback)
      } catch {
        if (!cancelled) setModels([])
      }
    })()
    return () => { cancelled = true }
  }, [selectedModel])

  const start = useCallback(async () => {
    if (running) return
    setRunning(true)
    setStatus('Starting…')
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const run = {
      id: runId,
      createdAt: new Date().toISOString(),
      model: model || '',
      residency: residency || 'always_hot',
      contextLengths: CONTEXT_LENGTHS,
      turnsPerContext: 5,
      rows: [],
    }

    try {
      for (let idx = 0; idx < CONTEXT_LENGTHS.length; idx += 1) {
        const ctx = CONTEXT_LENGTHS[idx]
        setStatus(`Context ${ctx} (${idx + 1}/${CONTEXT_LENGTHS.length})…`)

        const chat = await adapter.createChat(`TTFT test · ${ctx}`, model || '')
        const chatId = chat?.id
        if (!chatId) throw new Error('Failed to create chat.')

        const ttf = []
        for (let turn = 0; turn < 5; turn += 1) {
          const prompt = turn === 0
            ? 'TTFT test. Reply with exactly: ok'
            : `TTFT test follow-up ${turn}. Reply with exactly: ok`

          const { metrics } = await runSingleTurn({
            chatId,
            model: model || '',
            numCtx: ctx,
            text: prompt,
            abortSignal: ctrl.signal,
          })
          const value = metrics.serverFirstTokenMs ?? metrics.clientFirstTokenMs
          ttf.push(Number.isFinite(value) ? value : null)
        }

        const firstTtftMs = ttf[0]
        const avgNextTtftMs = mean(ttf.slice(1))
        run.rows.push({
          ctx,
          turnTtftMs: ttf,
          firstTtftMs,
          avgNextTtftMs,
        })

        setRuns((prev) => [run, ...(prev || [])].slice(0, 40))
      }

      setStatus('Done.')
    } catch (e) {
      if (e?.name === 'AbortError') setStatus('Stopped.')
      else setStatus(e?.message || 'Failed.')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [model, residency, running, setRuns])

  const stop = useCallback(() => {
    abortRef.current?.abort?.()
  }, [])

  const clearRuns = useCallback(() => {
    setRuns([])
  }, [setRuns])

  const exportLatest = useCallback(() => {
    if (!latestRun) return
    const safeModel = String(latestRun.model || 'model').replace(/[^a-z0-9._-]+/gi, '_')
    downloadJson(`ttft-${safeModel}-${latestRun.id}.json`, latestRun)
  }, [latestRun])

  return (
    <div className="ttftPage">
      <div className="ttftHeader">
        <div>
          <div className="ttftTitle">/test — TTFT bench</div>
          <div className="ttftSubtitle">Runs a 5-turn back-and-forth per context length and graphs first TTFT vs avg of next 4.</div>
        </div>
        <div className="ttftHeaderActions">
          <a className="ttftLink" href="/">Back to chat</a>
        </div>
      </div>

      <div className="ttftControls">
        <label className="ttftField">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
            {models.length === 0 ? <option value="">(no models)</option> : null}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="ttftField">
          <span>Residency</span>
          <input value={residency || ''} disabled readOnly />
        </label>
        <label className="ttftField">
          <span>Context lengths</span>
          <input value={CONTEXT_LENGTHS.join(', ')} disabled readOnly />
        </label>

        <div className="ttftButtons">
          <button type="button" onClick={() => void start()} disabled={running || !model}>Run</button>
          <button type="button" onClick={stop} disabled={!running}>Stop</button>
          <button type="button" onClick={exportLatest} disabled={!latestRun}>Export latest JSON</button>
          <button type="button" onClick={clearRuns} disabled={(runs || []).length === 0}>Clear</button>
        </div>
      </div>

      <div className="ttftStatus" role="status" aria-live="polite">
        <strong>Status</strong>
        <span>{status || (running ? 'Running…' : 'Idle')}</span>
        {latestRun ? <small>latest: {latestRun.createdAt} · {latestRun.model}</small> : <small>no runs yet</small>}
      </div>

      <MiniLineChart rows={rows} />

      <div className="ttftTableWrap">
        <table className="ttftTable">
          <thead>
            <tr>
              <th>ctx</th>
              <th>first TTFT (ms)</th>
              <th>avg next 4 (ms)</th>
              <th>turns (ms)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ctx}>
                <td>{r.ctx}</td>
                <td>{Number.isFinite(r.firstTtftMs) ? Math.round(r.firstTtftMs) : '--'}</td>
                <td>{Number.isFinite(r.avgNextTtftMs) ? Math.round(r.avgNextTtftMs) : '--'}</td>
                <td className="mono">{(r.turnTtftMs || []).map((v) => (Number.isFinite(v) ? Math.round(v) : '--')).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(runs || []).length > 1 && (
        <div className="ttftRunsMeta">
          <strong>Saved runs</strong>
          <span>{runs.length} stored in localStorage</span>
        </div>
      )}
    </div>
  )
}

