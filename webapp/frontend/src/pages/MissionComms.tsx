import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, wsSpectrumURL, type SatelliteConfig } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useReadings } from '../components/MissionTelemetry'
import { useTelemetry } from '../telemetry/TelemetryContext'
import './mission-overview.css'
import './mission-comms.css'

/* Dashboard · Communications — mirrors the Mission Control mockup. Every value
   is the saved receiver profile, the live spectrum stream, received packets or
   "—"; the dB scale is relative (not calibrated dBm). */

interface SpectrumFrame { ts: number; center_freq_hz: number; sample_rate_hz: number; freq_hz: number[]; power_db: number[] }

const SNR_WINDOW_S = 30
const WF_ROWS = 160
const WF_W = 1000
const DRIVER: Record<string, string> = { mcu: 'MCU (UART)', limesdr: 'LimeSDR', rtlsdr: 'RTL-SDR' }

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const peakOverMedian = (f: SpectrumFrame) => Math.max(...f.power_db) - median(f.power_db)

function useSpectrum(active: boolean, paused: boolean) {
  const [frame, setFrame] = useState<SpectrumFrame | null>(null)
  const [snr, setSnr] = useState<{ t: number; v: number }[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  useEffect(() => {
    if (!active) { setFrame(null); setSnr([]); return }
    let closed = false, ws: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | undefined, last = Date.now()
    const connect = () => {
      if (closed) return
      ws = new WebSocket(wsSpectrumURL())
      ws.onmessage = (ev) => {
        if (pausedRef.current) return
        try {
          const f = JSON.parse(ev.data) as SpectrumFrame
          if (!Array.isArray(f.power_db) || !Array.isArray(f.freq_hz) || f.power_db.length < 2 || f.power_db.length !== f.freq_hz.length || ![f.ts, f.center_freq_hz, f.sample_rate_hz, ...f.power_db, ...f.freq_hz].every(Number.isFinite)) return
          last = Date.now()
          setFrame(f)
          setSnr((prev) => [...prev, { t: f.ts, v: peakOverMedian(f) }].filter((p) => p.t >= f.ts - SNR_WINDOW_S))
        } catch { /* ignore malformed frames */ }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => { if (!closed) { setFrame(null); retry = setTimeout(connect, 2000) } }
    }
    connect()
    const stale = setInterval(() => { if (!pausedRef.current && Date.now() - last > 10000) setFrame(null) }, 1000)
    return () => { closed = true; clearTimeout(retry); clearInterval(stale); ws?.close() }
  }, [active])
  return { frame, snr }
}

function Card({ title, right, className = '', children }: { title: string; right?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`mo-card cm-card ${className}`}><div className="mo-head"><span className="mo-title">{title}</span>{right && <span className="mo-right">{right}</span>}</div>{children}</section>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="cm-field"><span>{label}</span><span className="cm-box">{children}</span></div>
}

/* Axis frame: HTML tick labels around an SVG plot area (crisp at any size). */
function Plot({ yTicks, yRange, xTicks, yLabel, xLabel, children, overlay }: { yTicks: number[]; yRange: [number, number]; xTicks: { at: number; label: string }[]; yLabel: string; xLabel: string; children?: ReactNode; overlay?: ReactNode }) {
  const [lo, hi] = yRange
  const yPct = (v: number) => (1 - (v - lo) / (hi - lo)) * 100
  return (
    <div className="cm-plot">
      <span className="cm-ylabel">{yLabel}</span>
      <div className="cm-area">
        {yTicks.map((t) => <span key={t} className="cm-yt" style={{ top: `${yPct(t)}%` }}>{t}</span>)}
        {xTicks.map((t) => <span key={t.at} className="cm-xt" style={{ left: `${t.at * 100}%` }}>{t.label}</span>)}
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden>
          {yTicks.map((t) => <line key={t} x1="0" x2="1000" y1={yPct(t)} y2={yPct(t)} className="cm-grid" />)}
          {xTicks.map((t) => <line key={t.at} x1={t.at * 1000} x2={t.at * 1000} y1="0" y2="100" className="cm-grid" />)}
          {children}
        </svg>
        {overlay}
      </div>
      <span className="cm-xlabel">{xLabel}</span>
    </div>
  )
}

function ticks(lo: number, hi: number, n = 5) {
  const step = (hi - lo) / (n - 1)
  return Array.from({ length: n }, (_, i) => Math.round(lo + step * i))
}
const fracTicks = (labels: (f: number) => string, n = 6) => Array.from({ length: n }, (_, i) => ({ at: i / (n - 1), label: labels(i / (n - 1)) }))

function Spectrum({ frame, range, active }: { frame: SpectrumFrame | null; range: [number, number]; active: boolean }) {
  const [lo, hi] = range
  const half = frame ? frame.sample_rate_hz / 2000 : null
  const path = useMemo(() => {
    if (!frame) return ''
    const n = frame.power_db.length - 1
    return frame.power_db.map((p, i) => `${i ? 'L' : 'M'}${((i / n) * 1000).toFixed(1)},${((1 - (Math.max(lo, Math.min(hi, p)) - lo) / (hi - lo)) * 100).toFixed(2)}`).join('')
  }, [frame, lo, hi])
  return (
    <Card title="RF SPECTRUM" right={<span className="cm-meta">{half ? `±${half.toFixed(0)} kHz` : '± — kHz'} · relative dB</span>}>
      <Plot yTicks={ticks(lo, hi)} yRange={range} yLabel="Power (dB)" xLabel="Frequency offset (kHz)"
        xTicks={fracTicks((f) => (half ? (-half + f * 2 * half).toFixed(0) : ''))}
        overlay={!frame && <span className="cm-hint">{active ? 'Waiting for spectrum data…' : 'Start the spectrum view'}</span>}>
        <line x1="500" x2="500" y1="0" y2="100" className="cm-mark" />
        {path && <path d={path} className="cm-trace" />}
      </Plot>
    </Card>
  )
}

function SignalPower({ snr, frame, active }: { snr: { t: number; v: number }[]; frame: SpectrumFrame | null; active: boolean }) {
  const now = snr.at(-1)?.t ?? 0
  const path = snr.length > 1 ? snr.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - (now - SNR_WINDOW_S)) / SNR_WINDOW_S) * 1000).toFixed(1)},${((1 - Math.max(0, Math.min(40, p.v)) / 40) * 100).toFixed(2)}`).join('') : ''
  return (
    <Card title="SIGNAL POWER" right={<span className="cm-meta">{frame ? `${(frame.center_freq_hz / 1e6).toFixed(3)} MHz` : '— MHz'}</span>}>
      <Plot yTicks={[0, 10, 20, 30, 40]} yRange={[0, 40]} yLabel="SNR (dB)" xLabel="Time (s) · peak / median estimate"
        xTicks={fracTicks((f) => String(Math.round(-SNR_WINDOW_S + f * SNR_WINDOW_S)))}
        overlay={!path && <span className="cm-hint">{active ? 'Collecting samples…' : 'No samples'}</span>}>
        {path && <path d={path} className="cm-trace cm-trace-snr" />}
      </Plot>
    </Card>
  )
}

function Waterfall({ frame, range, active, paused }: { frame: SpectrumFrame | null; range: [number, number]; active: boolean; paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const rowTs = useRef<number[]>([])
  const [lo, hi] = range
  useEffect(() => { const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, WF_W, WF_ROWS); rowTs.current = [] }, [active])
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !frame || paused) return
    ctx.putImageData(ctx.getImageData(0, 0, WF_W, WF_ROWS - 1), 0, 1)
    const row = ctx.createImageData(WF_W, 1), n = frame.power_db.length
    for (let x = 0; x < WF_W; x++) {
      const t = Math.max(0, Math.min(1, (frame.power_db[Math.floor((x / WF_W) * n)] - lo) / (hi - lo || 1)))
      const [a, b, u] = t < 0.6 ? [[11, 17, 32], [2, 132, 199], t / 0.6] as const : [[2, 132, 199], [255, 255, 255], (t - 0.6) / 0.4] as const
      for (let k = 0; k < 3; k++) row.data[x * 4 + k] = a[k] + (b[k] - a[k]) * u
      row.data[x * 4 + 3] = 255
    }
    ctx.putImageData(row, 0, 0)
    rowTs.current = [frame.ts, ...rowTs.current].slice(0, WF_ROWS)
  }, [frame, paused, lo, hi])
  const half = frame ? frame.sample_rate_hz / 2000 : null
  const rows = rowTs.current, newest = rows[0]
  // time ticks from real row timestamps (rows older than the buffer are blank)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const ts = rows[Math.min(rows.length - 1, Math.round(f * (WF_ROWS - 1)))]; return { f, label: newest != null && ts != null && Math.round(f * (WF_ROWS - 1)) < rows.length ? (ts - newest).toFixed(0) : '' } })
  return (
    <Card title="WATERFALL" right={<span className="cm-meta">{lo} … {hi} dB</span>}>
      <div className="cm-plot">
        <span className="cm-ylabel">Time (s)</span>
        <div className="cm-area cm-wf">
          {yTicks.map((t) => <span key={t.f} className="cm-yt" style={{ top: `${t.f * 100}%` }}>{t.label}</span>)}
          {fracTicks((f) => (half ? (-half + f * 2 * half).toFixed(0) : '')).map((t) => <span key={t.at} className="cm-xt" style={{ left: `${t.at * 100}%` }}>{t.label}</span>)}
          <canvas ref={canvas} width={WF_W} height={WF_ROWS} />
          {!frame && <span className="cm-hint cm-hint-dark">{active ? 'Waiting for spectrum data…' : 'Start the spectrum view'}</span>}
        </div>
        <span className="cm-xlabel">Frequency offset (kHz)</span>
      </div>
    </Card>
  )
}

type Line = { ts: number; text: string; kind?: 'ok' | 'bad' | 'sys' }

function PacketConsole({ snrNow }: { snrNow: number | null }) {
  const { logs, messages } = useTelemetry()
  const [cutoff, setCutoff] = useState(0)
  const [paused, setPaused] = useState<Line[] | null>(null)
  const [filter, setFilter] = useState('')
  const [local, setLocal] = useState<Line[]>([{ ts: Date.now() / 1000, text: 'Type HELP for available commands.', kind: 'sys' }])
  const [cmd, setCmd] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const sdr = messages.filter((m) => m.source === 'sdr')
  const valid = sdr.filter((m) => m.decoded).length
  const entries: Line[] = [
    ...logs.map((l) => ({ ts: l.ts, text: l.text })),
    ...sdr.map((m) => ({ ts: m.ts, text: `${m.pkt_type_name || `type ${m.pkt_type}`} · ${m.decoded ? 'decoded' : `error: ${m.error || '?'}`} · ${m.size_bytes} B`, kind: (m.decoded ? 'ok' : 'bad') as Line['kind'] })),
  ]
  const shown = [...(paused ?? entries).filter((e) => e.ts > cutoff && e.text.toLowerCase().includes(filter.toLowerCase())), ...local].sort((a, b) => a.ts - b.ts).slice(-300)
  const lastTs = shown.at(-1)?.ts
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [lastTs])
  const say = (text: string, kind: Line['kind'] = 'sys') => setLocal((l) => [...l, { ts: Date.now() / 1000, text, kind }].slice(-60))
  // console commands act on this view only; nothing is sent to the receiver
  function run(raw: string) {
    const [c, ...rest] = raw.trim().split(/\s+/)
    if (!c) return
    say(`> ${raw.trim()}`)
    switch (c.toLowerCase()) {
      case 'help': say('help · clear · pause · resume · filter <text> · filter · stats  (view commands; nothing is sent to the receiver)'); break
      case 'clear': setCutoff(Date.now() / 1000); setLocal([]); break
      case 'pause': setPaused(entries); say('Console paused.'); break
      case 'resume': setPaused(null); say('Console resumed.'); break
      case 'filter': setFilter(rest.join(' ')); say(rest.length ? `Filter: "${rest.join(' ')}"` : 'Filter cleared.'); break
      case 'stats': say(`Total ${sdr.length} · valid ${valid} · rejected ${sdr.length - valid}`); break
      default: say(`Unknown command "${c}". Type HELP.`, 'bad')
    }
  }
  return (
    <section className="mo-card cm-card cm-console">
      <div className="mo-head"><span className="mo-title">DECODED PACKETS</span><span className="mo-right">{paused && <span className="mo-tag mo-tag-info">PAUSED</span>}<button onClick={() => { setCutoff(Date.now() / 1000); setLocal([]) }}>Clear</button></span></div>
      <div className="cm-counters"><span>Total: <b>{sdr.length}</b></span><span>Valid: <b>{valid}</b></span><span>Rejected: <b>{sdr.length - valid}</b></span><span>SNR: <b>{snrNow == null ? '—' : `${snrNow.toFixed(1)} dB`}</b></span>{filter && <span>Filter: <b>{filter}</b></span>}</div>
      <div ref={list} className="cm-log" role="log">
        {!entries.length && <div className="cm-dim">Waiting for received data…</div>}
        {shown.map((e, i) => <div key={`${e.ts}-${i}`} className={e.kind ?? ''}>{e.kind === 'sys' ? e.text : <><time>[{new Date(e.ts * 1000).toISOString().slice(11, 19)}]</time> {e.text}</>}</div>)}
      </div>
      <form className="cm-cmd" onSubmit={(e) => { e.preventDefault(); run(cmd); setCmd('') }}>
        <b>RF-CMD&gt;</b><input aria-label="Console command" placeholder="Type help for commands…" value={cmd} onChange={(e) => setCmd(e.target.value)} /><button type="submit">Send</button>
      </form>
    </section>
  )
}

export function Comms() {
  const { authenticated } = useAuth()
  const { logs, messages } = useTelemetry()
  const read = useReadings()
  const [cfg, setCfg] = useState<SatelliteConfig | null>(null)
  const [active, setActive] = useState(false)
  const [range, setRange] = useState<[number, number]>([-120, 0])
  const { frame, snr } = useSpectrum(active, false)
  useEffect(() => { let alive = true; if (authenticated) api.getSatellite().then((c) => { if (alive) setCfg(c) }).catch(() => {}); return () => { alive = false } }, [authenticated])
  const r = cfg?.reception
  const metric = (ch: string, unit: string, d: number) => { const v = read(ch); return v ? `${v.value.toFixed(d)}${unit}` : `—${unit}` }
  const snrNow = snr.at(-1)?.v ?? null

  function exportDump() {
    const blob = new Blob([JSON.stringify({ exported_utc: new Date().toISOString(), messages, logs }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `intisat-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="page cm-page">
      <div className="cm-linkbar">
        <strong>LINK METRICS</strong>
        <span>RSSI: <b>{metric('coms_rssi', ' dBm', 1)}</b></span>
        <span>SNR: <b>{metric('coms_snr', ' dB', 1)}</b></span>
        <span>Downlink: <b>{metric('coms_downlink_rate', ' bps', 0)}</b></span>
        <span>BER: <b>{metric('coms_ber', '', 5)}</b></span>
        <em>{r ? `${DRIVER[r.driver] ?? r.driver} receiver` : 'Receiver profile —'}</em>
      </div>

      <div className="cm-main">
        <div className="cm-left">
          <Card title="DEVICE" right={<span className="cm-meta">{active ? (frame ? 'STREAMING' : 'CONNECTING') : 'IDLE'}</span>}>
            <select disabled value={r?.driver ?? ''} title="Saved receiver driver · change it in Settings" aria-label="Receiver driver">
              <option value="">{authenticated ? '—' : 'Sign in to read driver'}</option>
              {Object.entries(DRIVER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <div className="cm-btns">
              <button className="cm-start" disabled={active} onClick={() => setActive(true)} title="Start the live spectrum view">▶ Start</button>
              <button className="cm-stop" disabled={!active} onClick={() => setActive(false)} title="Stop the live spectrum view">■ Stop</button>
            </div>
          </Card>
          <Card title="RF SETTINGS">
            <Field label="Center (MHz)">{r ? r.frequency_mhz.toFixed(3) : '—'}</Field>
            <div className="cm-field"><span>RF gain</span><span className="cm-meter"><i style={{ width: r ? `${Math.max(0, Math.min(100, (r.gain_db / 70) * 100))}%` : 0 }} /></span><b className="cm-num">{r ? `${r.gain_db.toFixed(0)} dB` : '—'}</b></div>
            <small>Baseband span: {frame ? `±${(frame.sample_rate_hz / 2000).toFixed(0)} kHz` : '—'} · saved profile</small>
          </Card>
          <Card title="DEMODULATION">
            <Field label="Modulation">{r?.modulation ?? '—'}</Field>
            <Field label="Bandwidth (Hz)">—</Field>
            <Field label="Symbol rate (sps)">—</Field>
            <Field label="Freq. dev. (Hz)">—</Field>
            <Field label="Sync word">{r?.sync_word ?? '—'}</Field>
            <small>Bandwidth, rate and deviation need runtime readback.</small>
          </Card>
          <Card title="POWER GATE">
            <Field label="Threshold">—</Field>
            <small>Not reported by the receiver.</small>
          </Card>
          <Card title="UPLINK TX"><small>Not available · receive-only console</small></Card>
          <Card title="WATERFALL LEVELS">
            <div className="cm-field"><span>Min level</span><input type="range" min={-160} max={range[1] - 10} value={range[0]} onChange={(e) => setRange([Number(e.target.value), range[1]])} /><b className="cm-num">{range[0]} dB</b></div>
            <div className="cm-field"><span>Max level</span><input type="range" min={range[0] + 10} max={20} value={range[1]} onChange={(e) => setRange([range[0], Number(e.target.value)])} /><b className="cm-num">{range[1]} dB</b></div>
          </Card>
          <Card title="TELEMETRY DUMP">
            <div className="cm-field"><span>Local JSON export</span><button className="cm-export" onClick={exportDump} disabled={!messages.length && !logs.length}>↓ Export</button></div>
          </Card>
        </div>

        <div className="cm-center">
          <Spectrum frame={frame} range={range} active={active} />
          <SignalPower snr={snr} frame={frame} active={active} />
          <Waterfall frame={frame} range={range} active={active} paused={false} />
        </div>

        <PacketConsole snrNow={snrNow} />
      </div>
    </div>
  )
}
