import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type HistoryPoint } from '../api'
import { useReadings } from '../components/MissionTelemetry'
import './mission-overview.css'
import './mission-eps.css'

type Read = ReturnType<typeof useReadings>

const fmt = (v: number | undefined, d = 2, unit = '') => (v == null ? '—' : `${v.toFixed(d)}${unit ? ` ${unit}` : ''}`)

function Card({ title, accent = '#478bb9', icon, right, className = '', children }: { title: string; accent?: string; icon?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`mo-card ${className}`} style={{ ['--mo-accent' as string]: accent }}>
      <div className={`mo-head${icon ? ' with-icon' : ''}`}>
        {icon && <span className="ep-icon" style={{ color: accent }}>{icon}</span>}
        <span className="mo-title">{title}</span>
        {right && <span className="mo-right">{right}</span>}
      </div>
      {children}
    </section>
  )
}

/* Rolling buffer of live readings for sparklines (no fabricated samples). */
function useLiveBuffer(read: Read, channels: string[], size = 60) {
  const buf = useRef<Record<string, { ts: number; v: number }[]>>({})
  for (const ch of channels) {
    const r = read(ch)
    const arr = (buf.current[ch] ??= [])
    if (r && (!arr.length || arr[arr.length - 1].ts !== r.ts)) {
      arr.push({ ts: r.ts, v: r.value })
      if (arr.length > size) arr.shift()
    }
  }
  return buf.current
}

function Spark({ data }: { data?: { v: number }[] }) {
  if (!data || data.length < 2) return <svg className="ep-spark" viewBox="0 0 64 16" aria-hidden><path d="M1 8H63" stroke="#e2e8f0" strokeWidth="1.2" strokeDasharray="2 2" /></svg>
  const vs = data.map((d) => d.v)
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (lo === hi) { lo -= 1; hi += 1 }
  const d = vs.map((v, i) => `${i ? 'L' : 'M'}${(1 + (i / (vs.length - 1)) * 62).toFixed(1)},${(14 - ((v - lo) / (hi - lo)) * 12).toFixed(1)}`).join(' ')
  return <svg className="ep-spark" viewBox="0 0 64 16" aria-hidden><path d={d} fill="none" stroke="#008dff" strokeWidth="1.5" strokeLinejoin="round" /></svg>
}

function Row({ label, value, spark, children }: { label: string; value?: string; spark?: { v: number }[]; children?: ReactNode }) {
  return (
    <div className="ep-metric">
      <label>{label}</label>
      {children ?? <span className="ep-value">{value}</span>}
      {spark !== undefined && <Spark data={spark} />}
    </div>
  )
}

/* ── history charts ── */
type Series = { channel: string; label: string; color: string; unit: string; axis?: 'left' | 'right'; points: HistoryPoint[] }

function useHistories(channels: string[], minutes: number) {
  const [data, setData] = useState<Record<string, HistoryPoint[]>>({})
  const [failed, setFailed] = useState(false)
  const key = channels.join(',')
  useEffect(() => {
    let alive = true
    const load = () => Promise.all(channels.map((c) => api.history(c, minutes).then((r) => [c, r.points] as const)))
      .then((rows) => { if (alive) { setData(Object.fromEntries(rows)); setFailed(false) } })
      .catch(() => { if (alive) setFailed(true) })
    load()
    const id = setInterval(load, 30000)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minutes])
  return { data, failed }
}

function niceTicks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1
  const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? step0
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step
  const out: number[] = []
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

function LineChart({ series, failed, yLabel, y2Label }: { series: Series[]; failed: boolean; yLabel: string; y2Label?: string }) {
  const withData = series.filter((s) => s.points.length > 1)
  if (!withData.length) return <div className="ep-chart"><div className="ep-plot ep-grid" /><span className="mo-empty">{failed ? 'History unavailable' : 'No samples in this range yet'}</span></div>
  const all = withData.flatMap((s) => s.points)
  const t0 = Math.min(...all.map((p) => p.ts)), t1 = Math.max(...all.map((p) => p.ts))
  const axes = (['left', 'right'] as const).map((side) => {
    const vals = withData.filter((s) => (s.axis ?? 'left') === side).flatMap((s) => s.points.map((p) => p.value))
    if (!vals.length) return null
    let lo = Math.min(...vals), hi = Math.max(...vals)
    if (lo === hi) { lo -= 1; hi += 1 }
    const pad = (hi - lo) * 0.08
    const ticks = niceTicks(lo - pad, hi + pad)
    return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1] }
  })
  const left = axes[0] ?? axes[1]!, right = axes[1]
  const X = (ts: number) => ((ts - t0) / (t1 - t0 || 1)) * 1000
  const Y = (v: number, ax: { lo: number; hi: number }) => 100 - ((v - ax.lo) / (ax.hi - ax.lo || 1)) * 100
  const xTicks = Array.from({ length: 7 }, (_, k) => t0 + ((t1 - t0) * k) / 6)
  const span = t1 - t0
  const tl = (ts: number) => new Date(ts * 1000).toISOString().slice(span > 2 * 86400 ? 5 : 11, span > 2 * 86400 ? 16 : 16).replace('T', ' ')
  return (
    <div className={`ep-chart${right ? ' dual' : ''}`}>
      <div className="ep-plot">
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
          {left.ticks.map((t) => <line key={t} x1="0" x2="1000" y1={Y(t, left)} y2={Y(t, left)} stroke="#eaf0f7" vectorEffect="non-scaling-stroke" />)}
          {xTicks.map((t, k) => <line key={k} y1="0" y2="100" x1={X(t)} x2={X(t)} stroke="#eaf0f7" vectorEffect="non-scaling-stroke" />)}
          {withData.map((s) => {
            const ax = (s.axis ?? 'left') === 'right' && right ? right : left
            const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.value, ax).toFixed(2)}`).join(' ')
            return <path key={s.channel} d={d} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          })}
        </svg>
        {left.ticks.map((t) => <span key={t} className="ep-yt" style={{ top: `${Y(t, left)}%` }}>{+t.toFixed(2)}</span>)}
        {right && right.ticks.map((t) => <span key={t} className="ep-yt r" style={{ top: `${Y(t, right)}%` }}>{+t.toFixed(2)}</span>)}
        {xTicks.map((t, k) => <span key={k} className="ep-xt" style={{ left: `${(k / 6) * 100}%` }}>{tl(t)}</span>)}
      </div>
      <span className="ep-ylabel">{yLabel}</span>
      {right && y2Label && <span className="ep-ylabel r">{y2Label}</span>}
      <span className="ep-xlabel">Time (UTC)</span>
    </div>
  )
}

function Keys({ items }: { items: { label: string; color: string }[] }) {
  return <>{items.map((k) => <span key={k.label} className="ep-key"><i style={{ background: k.color }} />{k.label}</span>)}</>
}

const RANGES = [{ l: '30 min', m: 30 }, { l: '1 h', m: 60 }, { l: '6 h', m: 360 }, { l: '24 h', m: 1440 }]

/* ── page ── */
const POWER = [
  { key: 'OBC', ch: 'eps_pwr_obc', color: '#008dff' },
  { key: 'Comms', ch: 'eps_pwr_comms', color: '#ff9e00' },
  { key: 'ADCS', ch: 'eps_pwr_adcs', color: '#8d30f5' },
  { key: 'TCS', ch: 'eps_pwr_tcs', color: '#13c77b' },
]

export function EpsThermal() {
  const read = useReadings()
  const [range, setRange] = useState(60)
  const sparkCh = ['eps_batt_voltage', 'eps_batt_current', 'eps_batt_soc', 'eps_bus_voltage', 'eps_bus_current', 'eps_solar_total_power', 'tcs_heater_current', 'eps_batt_temp', 'obc_temp', 'coms_pa_temp']
  const buf = useLiveBuffer(read, sparkCh)
  const sp = (ch: string) => buf[ch]

  const heater = read('tcs_heater_current')?.value
  const vals = POWER.map((p) => read(p.ch)?.value)
  const complete = vals.every((v) => v != null && v >= 0)
  const total = complete ? vals.reduce<number>((a, v) => a + v!, 0) : undefined
  let cursor = 0
  const stops = POWER.map((p, i) => { const s = cursor; cursor += total ? (vals[i]! / total) * 100 : 0; return `${p.color} ${s}% ${cursor}%` })

  const powerH = useHistories(POWER.map((p) => `sim.${p.ch}`), range)
  const battH = useHistories(['sim.eps_batt_voltage', 'sim.eps_batt_current'], range)
  const heatH = useHistories(['sim.obc_temp', 'sim.coms_pa_temp', 'sim.eps_batt_temp'], range)

  // total consumption = sum of the four subsystem channels at matching timestamps
  const byTs = new Map<number, number[]>()
  POWER.forEach((p, i) => (powerH.data[`sim.${p.ch}`] ?? []).forEach((pt) => { const a = byTs.get(pt.ts) ?? [NaN, NaN, NaN, NaN]; a[i] = pt.value; byTs.set(pt.ts, a) }))
  const totalPts = [...byTs.entries()].filter(([, a]) => a.every(Number.isFinite)).sort((a, b) => a[0] - b[0]).map(([ts, a]) => ({ ts, value: a.reduce((s, v) => s + v, 0) }))

  const rangeSel = (
    <label className="ep-range">History
      <select value={range} onChange={(e) => setRange(+e.target.value)}>{RANGES.map((r) => <option key={r.m} value={r.m}>{r.l}</option>)}</select>
    </label>
  )

  return (
    <div className="page ep-page">
      <div className="ep-top">
        <Card title="POWER DISTRIBUTION (EPS)" accent="#ff9c00" icon="ϟ">
          <div className="ep-metrics">
            <Row label="Battery Voltage" value={fmt(read('eps_batt_voltage')?.value, 2, 'V')} spark={sp('eps_batt_voltage')} />
            <Row label="Battery Current" value={fmt(read('eps_batt_current')?.value, 2, 'A')} spark={sp('eps_batt_current')} />
            <Row label="State of Charge" value={fmt(read('eps_batt_soc')?.value, 1, '%')} spark={sp('eps_batt_soc')} />
            <Row label="Bus Voltage" value={fmt(read('eps_bus_voltage')?.value, 2, 'V')} spark={sp('eps_bus_voltage')} />
            <Row label="Bus Current" value={fmt(read('eps_bus_current')?.value, 2, 'A')} spark={sp('eps_bus_current')} />
            <Row label="Solar Input" value={fmt(read('eps_solar_total_power')?.value, 2, 'W')} spark={sp('eps_solar_total_power')} />
          </div>
        </Card>
        <Card title="THERMAL CONTROL (TCS)" icon="❄" accent="#0099ff">
          <div className="ep-metrics">
            <Row label="Heater Status">
              <span className={`ep-pill ${heater == null ? '' : heater > 0.01 ? 'on' : 'off'}`}>{heater == null ? '—' : heater > 0.01 ? 'ON' : 'OFF'}</span>
            </Row>
            <Row label="Heater Current" value={fmt(heater, 3, 'A')} spark={sp('tcs_heater_current')} />
            <Row label="Battery Temp." value={fmt(read('eps_batt_temp')?.value, 1, '°C')} spark={sp('eps_batt_temp')} />
            <Row label="OBC Temp." value={fmt(read('obc_temp')?.value, 1, '°C')} spark={sp('obc_temp')} />
            <Row label="PA Temp." value={fmt(read('coms_pa_temp')?.value, 1, '°C')} spark={sp('coms_pa_temp')} />
          </div>
        </Card>
        <Card title="ON-BOARD COMPUTER" icon="▦" accent="#0099ff">
          <div className="ep-metrics ep-cpu">
            {[['CPU Load', 'obc_cpu_load'], ['RAM Usage', 'obc_ram_usage'], ['Filesystem Usage', 'obc_fs_usage']].map(([label, ch]) => {
              const v = read(ch)?.value
              return (
                <Row key={ch} label={label}>
                  <div className="ep-track"><span style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }} /></div>
                  <span className="ep-value">{v == null ? '— %' : `${v.toFixed(0)} %`}</span>
                </Row>
              )
            })}
            <Row label="Uptime" value={(() => { const u = read('obc_uptime')?.value; if (u == null) return '—'; const p = (n: number) => String(Math.floor(n)).padStart(2, '0'); return `${p(u / 3600)}:${p((u % 3600) / 60)}:${p(u % 60)}` })()} />
          </div>
        </Card>
      </div>

      <div className="ep-mid">
        <Card title="POWER CONSUMPTION SHARE">
          <div className="ep-donutwrap">
            <div className="ep-donut" style={{ background: total ? `conic-gradient(${stops.join(',')})` : 'var(--border-subtle)' }}>
              <div><b>{total == null ? '—' : `${total.toFixed(2)} W`}</b><small>TOTAL</small></div>
            </div>
            <div className="ep-legend">
              {POWER.map((p, i) => (
                <div key={p.key}><i style={{ background: p.color }} />{p.key}<b>{total && vals[i] != null ? `${((vals[i]! / total) * 100).toFixed(0)}%` : '—'}</b><em>{fmt(vals[i], 2, 'W')}</em></div>
              ))}
            </div>
          </div>
        </Card>
        <Card title="CONSUMPTION HISTORY" right={<><Keys items={[{ label: 'OBC + Comms + ADCS + TCS (W)', color: '#00a8ee' }]} />{rangeSel}</>}>
          <LineChart failed={powerH.failed} yLabel="Power (W)" series={[{ channel: 'total', label: 'Total', color: '#00a8ee', unit: 'W', points: totalPts }]} />
        </Card>
      </div>

      <div className="ep-bottom">
        <Card title="BATTERY DRAIN" right={<Keys items={[{ label: 'Battery Voltage (V)', color: '#008dff' }, { label: 'Battery Current (A)', color: '#ff9e00' }]} />}>
          <LineChart failed={battH.failed} yLabel="Voltage (V)" y2Label="Current (A)" series={[
            { channel: 'v', label: 'Voltage', color: '#008dff', unit: 'V', points: battH.data['sim.eps_batt_voltage'] ?? [] },
            { channel: 'i', label: 'Current', color: '#ff9e00', unit: 'A', axis: 'right', points: battH.data['sim.eps_batt_current'] ?? [] },
          ]} />
        </Card>
        <Card title="THERMAL HISTORY" right={<Keys items={[{ label: 'OBC (°C)', color: '#ff9e00' }, { label: 'PA (°C)', color: '#ff304d' }, { label: 'Battery (°C)', color: '#13c77b' }]} />}>
          <LineChart failed={heatH.failed} yLabel="Temperature (°C)" series={[
            { channel: 'obc', label: 'OBC', color: '#ff9e00', unit: '°C', points: heatH.data['sim.obc_temp'] ?? [] },
            { channel: 'pa', label: 'PA', color: '#ff304d', unit: '°C', points: heatH.data['sim.coms_pa_temp'] ?? [] },
            { channel: 'bt', label: 'Battery', color: '#13c77b', unit: '°C', points: heatH.data['sim.eps_batt_temp'] ?? [] },
          ]} />
        </Card>
      </div>

      <Card title="SOLAR PANEL TELEMETRY" className="ep-solarcard" right={<span className="mo-total">TOTAL: <b>{fmt(read('eps_solar_total_power')?.value, 2, 'W')}</b></span>}>
        <div className="ep-solar">
          {[1, 2, 3, 4, 5, 6].map((n) => {
            const v = read(`eps_solar_voltage_${n}`)?.value, i = read(`eps_solar_current_${n}`)?.value, t = read(`tcs_panel_temp_${n}`)?.value
            const p = v != null && i != null ? v * i : undefined
            return (
              <div key={n}>
                <b>P{n}</b> · {fmt(v, 2, 'V')}<br />
                {i == null ? '—' : `${(i * 1000).toFixed(0)} mA`} · {fmt(t, 1, '°C')}<br />
                {fmt(p, 2, 'W')} · {p == null ? 'NO DATA' : p > 0.01 ? 'GENERATING' : 'IDLE'}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
