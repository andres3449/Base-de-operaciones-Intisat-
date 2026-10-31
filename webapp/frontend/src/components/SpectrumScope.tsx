import { useEffect, useMemo, useRef, useState } from 'react'
import { useTelemetry } from '../telemetry/TelemetryContext'
import { wsSpectrumURL } from '../api'

interface SpectrumFrame {
  ts: number
  center_freq_hz: number
  sample_rate_hz: number
  freq_hz: number[]
  power_db: number[]
}

// Fixed, generously-high backing-store resolution for both canvases — the
// browser always scales this DOWN to the real display size, which is safe
// and stays sharp, unlike scaling a low-res canvas UP (the original blur
// bug). No devicePixelRatio, no ResizeObserver, no measured-width state:
// those all existed to chase crispness dynamically and kept breaking in
// ways invisible from here (no browser console access). A fixed oversized
// canvas needs none of that.
const PLOT_W = 2000
const SPEC_H = 120
const WF_H = 80
const BACKING_SCALE = 2

// Default dB range for both the trace's Y axis and the waterfall's color
// scale — matches the real PyQt5 app's SDR Spectrum tab range
// (GUI/pages/comms.py). Overridable via props (see Waterfall Min/Max on the
// SDR Diagnóstico page) — it's purely a display scale, never autoscaled per
// frame (autoscaling would make the same signal look different strength
// frame to frame), and never sent anywhere: it doesn't touch the hardware
// or the capture buffer, only how the already-received dB values are drawn.
const DB_MIN_DEFAULT = -120
const DB_MAX_DEFAULT = 0

const SNR_H = 70
const SNR_WINDOW_S = 30
const SNR_MIN = -10
const SNR_MAX = 40

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Single-hue (blue) sequential ramp, background -> accent-cyan -> white, so
// higher power always reads as "lighter", never a rainbow of hues.
function powerToRgb(db: number, min: number, max: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (db - min) / (max - min || 1)))
  const lerp = (a: number[], b: number[], u: number) => a.map((v, i) => v + (b[i] - v) * u) as [number, number, number]
  return t < 0.6 ? lerp([11, 17, 32], [2, 132, 199], t / 0.6) : lerp([2, 132, 199], [255, 255, 255], (t - 0.6) / 0.4)
}

// Round dB gridlines inside [min, max], ~10dB apart.
function dbTicks(min: number, max: number): number[] {
  const step = max - min > 30 ? 10 : 5
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max; v += step) ticks.push(v)
  return ticks
}

const SNR_TICKS = dbTicks(SNR_MIN, SNR_MAX)

function yAtDb(db: number, min: number, max: number, height: number): number {
  return height - ((db - min) / (max - min)) * (height - 4) - 2
}

interface SpectrumScopeProps {
  /** 'dark' matches the existing console-style panels (Dashboard, Logs).
   *  'light' matches the app's default instrument-panel chrome. The plot
   *  canvases themselves stay dark either way (same inset-display
   *  convention as the camera viewport) — only the surrounding chrome and
   *  axis text change. */
  theme?: 'dark' | 'light'
  title?: string
  /** Waterfall/trace dB range — display-only, see DB_MIN_DEFAULT above. */
  dbMin?: number
  dbMax?: number
}

export function SpectrumScope({
  theme = 'dark',
  title = 'LIVE RF SPECTRUM',
  dbMin = DB_MIN_DEFAULT,
  dbMax = DB_MAX_DEFAULT,
}: SpectrumScopeProps) {
  const { messages } = useTelemetry()
  const dbTicksMemo = useMemo(() => dbTicks(dbMin, dbMax), [dbMin, dbMax])
  const [active, setActive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frame, setFrame] = useState<SpectrumFrame | null>(null)
  // t = horizontal position as a 0..1 ratio (resolution-independent — usable
  // directly as a CSS percentage for the tooltip and, scaled by PLOT_W, as a
  // canvas coordinate for the crosshair).
  const [hover, setHover] = useState<{ t: number; db: number; freqMHz: number } | null>(null)
  const [snrHistory, setSnrHistory] = useState<{ t: number; snr: number }[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const waterfallRef = useRef<HTMLCanvasElement>(null)
  const snrCanvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!active) {
      setFrame(null)
      setSnrHistory([])
      return
    }
    let closed = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let lastFrame = Date.now()
    const connect = () => {
      if (closed) return
      ws = new WebSocket(wsSpectrumURL())
      ws.onmessage = (ev) => {
        if (pausedRef.current) return
        try {
          const f = JSON.parse(ev.data) as SpectrumFrame
          if (!Array.isArray(f.power_db) || !Array.isArray(f.freq_hz) || f.power_db.length < 2 || f.power_db.length !== f.freq_hz.length || ![f.ts,f.center_freq_hz,f.sample_rate_hz,...f.power_db,...f.freq_hz].every(Number.isFinite)) return
          lastFrame = Date.now()
          setFrame(f)
        } catch { /* Ignore malformed frames. */ }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => { if (!closed) { setFrame(null); setSnrHistory([]); retry = setTimeout(connect, 2000) } }
    }
    connect()
    const stale = setInterval(() => { if (!pausedRef.current && Date.now() - lastFrame > 10000) setFrame(null) }, 1000)
    return () => { closed = true; clearTimeout(retry); clearInterval(stale); ws?.close() }
  }, [active])

  // Clear the waterfall whenever streaming (re)starts, so stale rows from a
  // previous session/frequency don't linger under the new ones.
  useEffect(() => {
    const wf = waterfallRef.current
    const wctx = wf?.getContext('2d')
    if (wctx && wf) wctx.clearRect(0, 0, wf.width, wf.height)
  }, [active])

  // Rolling SNR-over-time sample (peak minus the frame's median = noise
  // floor estimate) — a real, frame-derived value, not a fabricated one.
  // Mirrors the PyQt app's "SIGNAL POWER @ freq" strip chart.
  useEffect(() => {
    if (!frame || paused) return
    const snr = Math.max(...frame.power_db) - median(frame.power_db)
    setSnrHistory((prev) => {
      const cutoff = frame.ts - SNR_WINDOW_S
      return [...prev, { t: frame.ts, snr }].filter((p) => p.t >= cutoff)
    })
  }, [frame, paused])

  // Packet counters — only `source: 'sdr'` rows, so they reflect this
  // receiver's own attempts, not MCU/UART traffic.
  const pktStats = useMemo(() => {
    const sdrMsgs = messages.filter((m) => m.source === 'sdr')
    const valid = sdrMsgs.filter((m) => m.decoded).length
    return { total: sdrMsgs.length, valid, rejected: sdrMsgs.length - valid }
  }, [messages])

  const instSnr = frame ? Math.max(...frame.power_db) - median(frame.power_db) : null

  // Line trace + dB gridlines. Axis text lives in DOM (see JSX) so it's
  // always crisp regardless of canvas resolution.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !frame) return
    const { power_db } = frame
    const H = SPEC_H * BACKING_SCALE
    const xAt = (i: number) => (i / (power_db.length - 1)) * PLOT_W
    const yAt = (db: number) => yAtDb(db, dbMin, dbMax, H)

    ctx.clearRect(0, 0, PLOT_W, H)

    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = BACKING_SCALE
    for (const t of dbTicksMemo) {
      const y = yAt(t)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(PLOT_W, y)
      ctx.stroke()
    }

    ctx.strokeStyle = '#0284c7'
    ctx.lineWidth = BACKING_SCALE * 1.4
    ctx.beginPath()
    power_db.forEach((p, i) => {
      const x = xAt(i)
      const y = yAt(p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Center-frequency marker (dashed), at freq_hz's zero-offset bin.
    const centerIdx = Math.floor(frame.freq_hz.length / 2)
    const cx = xAt(centerIdx)
    ctx.strokeStyle = '#eda100'
    ctx.lineWidth = BACKING_SCALE
    ctx.setLineDash([BACKING_SCALE * 3, BACKING_SCALE * 3])
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, H)
    ctx.stroke()
    ctx.setLineDash([])

    if (hover) {
      const hx = hover.t * PLOT_W
      const hy = yAtDb(hover.db, dbMin, dbMax, H)
      ctx.strokeStyle = 'rgba(148,163,184,0.5)'
      ctx.lineWidth = BACKING_SCALE
      ctx.beginPath()
      ctx.moveTo(hx, 0)
      ctx.lineTo(hx, H)
      ctx.stroke()
      ctx.fillStyle = '#38bdf8'
      ctx.beginPath()
      ctx.arc(hx, hy, 2.5 * BACKING_SCALE, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [frame, hover, dbMin, dbMax, dbTicksMemo])

  // Waterfall: scroll existing rows down, paint the newest frame at the top.
  useEffect(() => {
    const wf = waterfallRef.current
    const wctx = wf?.getContext('2d')
    if (!wctx || !frame || paused) return
    const { power_db } = frame
    const H = WF_H * BACKING_SCALE

    const img = wctx.getImageData(0, 0, PLOT_W, H - 1)
    wctx.putImageData(img, 0, 1)

    const row = wctx.createImageData(PLOT_W, 1)
    for (let x = 0; x < PLOT_W; x++) {
      const bin = Math.floor((x / PLOT_W) * power_db.length)
      const [r, g, b] = powerToRgb(power_db[bin], dbMin, dbMax)
      row.data[x * 4] = r
      row.data[x * 4 + 1] = g
      row.data[x * 4 + 2] = b
      row.data[x * 4 + 3] = 255
    }
    wctx.putImageData(row, 0, 0)
  }, [frame, paused, dbMin, dbMax])

  // SNR-over-time strip chart (last SNR_WINDOW_S seconds).
  useEffect(() => {
    const canvas = snrCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return
    const H = SNR_H * BACKING_SCALE
    const now = frame?.ts ?? Date.now() / 1000
    const xAt = (t: number) => ((t - (now - SNR_WINDOW_S)) / SNR_WINDOW_S) * PLOT_W
    const yAt = (snr: number) => yAtDb(Math.max(SNR_MIN, Math.min(SNR_MAX, snr)), SNR_MIN, SNR_MAX, H)

    ctx.clearRect(0, 0, PLOT_W, H)

    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = BACKING_SCALE
    for (const t of dbTicks(SNR_MIN, SNR_MAX)) {
      const y = yAt(t)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(PLOT_W, y)
      ctx.stroke()
    }

    if (snrHistory.length > 1) {
      ctx.strokeStyle = '#22ff88'
      ctx.lineWidth = BACKING_SCALE * 1.4
      ctx.beginPath()
      snrHistory.forEach((p, i) => {
        const x = xAt(p.t)
        const y = yAt(p.snr)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
  }, [snrHistory, frame])

  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!frame) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const i = Math.round(t * (frame.power_db.length - 1))
    const db = frame.power_db[i]
    setHover({ t, db, freqMHz: (frame.center_freq_hz + frame.freq_hz[i]) / 1e6 })
  }

  const wrapperClass = theme === 'dark' ? 'cmd-console-panel spectrum-panel' : 'pyqt-panel spectrum-panel spectrum-panel-light'

  return (
    <div className={wrapperClass}>
      <div className="pyqt-panel-title" style={{ justifyContent: 'space-between' }}>
        <span>
          {theme === 'dark' && (
            <span className="console-dots">
              <span />
              <span />
              <span />
            </span>
          )}
          {title}
          {paused ? ' — PAUSED' : ''}
        </span>
        <span style={{ display: 'flex', gap: 5 }}>
          {active && (
            <button type="button" className={paused ? 'mini-ctrl-btn accent' : 'mini-ctrl-btn'} onClick={() => setPaused((v) => !v)}>
              {paused ? 'Resume' : 'Freeze'}
            </button>
          )}
          <button
            type="button"
            className={active ? 'mini-ctrl-btn accent' : 'mini-ctrl-btn'}
            onClick={() => {
              setActive((v) => !v)
              setPaused(false)
            }}
          >
            {active ? 'Stop' : 'Start stream'}
          </button>
        </span>
      </div>
      {!active ? (
        <p className="empty-note">Stream stopped. Start to receive the raw RF spectrum and waterfall.</p>
      ) : (
        <>
          <div className="spectrum-stats">
            <span>
              Buffered packets: <b>{pktStats.total}</b>
            </span>
            <span>
              VALID: <b className="ok-text">{pktStats.valid}</b>
            </span>
            <span>
              REJECTED: <b className="bad-text">{pktStats.rejected}</b>
            </span>
            <span>Peak / median: {instSnr === null ? '—' : <b>{instSnr.toFixed(1)} dB</b>}</span>
          </div>
          <div className="spectrum-plot-row">
            <div className="spectrum-axis-y" style={{ height: SPEC_H }}>
              {dbTicksMemo.map((t) => (
                <span key={t} style={{ top: yAtDb(t, dbMin, dbMax, SPEC_H) }}>
                  {t}
                </span>
              ))}
            </div>
            <div className="spectrum-canvas-wrap">
              <canvas
                ref={canvasRef}
                width={PLOT_W}
                height={SPEC_H * BACKING_SCALE}
                className="spectrum-canvas"
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
              />
              {!frame && <p className="empty-note spectrum-connecting">Waiting for spectrum data…</p>}
              {hover && (
                <div className="chart-tooltip spectrum-tooltip" style={{ left: `${hover.t * 100}%`, top: `${(yAtDb(hover.db, dbMin, dbMax, SPEC_H) / SPEC_H) * 100}%` }}>
                  <div className="t">{hover.freqMHz.toFixed(4)} MHz</div>
                  <div className="v">{hover.db.toFixed(1)} dB</div>
                </div>
              )}
            </div>
          </div>
          <div className="spectrum-axis-x">
            <span className="spectrum-axis-x-spacer" />
            <div className="spectrum-axis-x-ticks">
              {frame &&
                [0, 0.5, 1].map((f) => {
                  const i = Math.round(f * (frame.freq_hz.length - 1))
                  return <span key={f}>{((frame.center_freq_hz + frame.freq_hz[i]) / 1e6).toFixed(3)}</span>
                })}
            </div>
          </div>
          <div className="spectrum-subtitle">Peak / median estimate · last {SNR_WINDOW_S}s · relative dB</div>
          <div className="spectrum-plot-row spectrum-snr-row">
            <div className="spectrum-axis-y" style={{ height: SNR_H }}>
              {SNR_TICKS.map((t) => (
                <span key={t} style={{ top: yAtDb(t, SNR_MIN, SNR_MAX, SNR_H) }}>
                  {t}
                </span>
              ))}
            </div>
            <canvas ref={snrCanvasRef} width={PLOT_W} height={SNR_H * BACKING_SCALE} className="spectrum-snr-canvas" />
          </div>
          <div className="spectrum-axis-x">
            <span className="spectrum-axis-x-spacer" />
            <div className="spectrum-axis-x-ticks">
              <span>-{SNR_WINDOW_S}s</span>
              <span>-{SNR_WINDOW_S / 2}s</span>
              <span>0s</span>
            </div>
          </div>
          <div className="spectrum-waterfall-row">
            <span className="spectrum-axis-x-spacer" />
            <canvas ref={waterfallRef} width={PLOT_W} height={WF_H * BACKING_SCALE} className="spectrum-waterfall" />
          </div>
          <div className="spectrum-scale">
            <span>{dbMin} dB</span>
            <div className="spectrum-scale-grad" />
            <span>{dbMax} dB</span>
          </div>
          {frame && (
            <div className="spectrum-meta">
              <span>{(frame.center_freq_hz / 1e6).toFixed(4)} MHz</span>
              <span>{(frame.sample_rate_hz / 1e3).toFixed(1)} kHz BW</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
