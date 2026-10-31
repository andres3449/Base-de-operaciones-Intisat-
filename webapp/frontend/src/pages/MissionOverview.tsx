import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, type HistoryPoint, type ImageInfo } from '../api'
import { useReadings } from '../components/MissionTelemetry'
import { useTelemetry } from '../telemetry/TelemetryContext'
import './mission-overview.css'

type Read = ReturnType<typeof useReadings>

function fmt(v: number | undefined, decimals = 2, unit = '') {
  return v == null ? '—' : `${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`
}

function Card({ title, accent, tag, right, className = '', children }: { title: string; accent: string; tag?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`mo-card ${className}`} style={{ ['--mo-accent' as string]: accent }}>
      <div className="mo-head">
        <span className="mo-title">{title}</span>
        {tag}
        {right && <span className="mo-right">{right}</span>}
      </div>
      {children}
    </section>
  )
}

function Tag({ tone = 'ok', children }: { tone?: 'ok' | 'off' | 'info'; children: ReactNode }) {
  return <span className={`mo-tag mo-tag-${tone}`}>{children}</span>
}

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="mo-tile">
      <small>{label}</small>
      <b style={color ? { color } : undefined}>{value}</b>
    </div>
  )
}

function formatUptime(s: number) {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}

/* ── top strip ── */
function OverviewStrip({ read }: { read: Read }) {
  const up = read('obc_uptime')?.value
  return (
    <div className="mo-strip">
      <strong>MISSION OVERVIEW</strong>
      <div className="mo-kpi"><small>VBATT</small><b>{fmt(read('eps_batt_voltage')?.value, 2, 'V')}</b></div>
      <div className="mo-kpi"><small>IBATT</small><b>{fmt(read('eps_batt_current')?.value, 2, 'A')}</b></div>
      <div className="mo-kpi"><small>VBUS</small><b>{fmt(read('eps_bus_voltage')?.value, 2, 'V')}</b></div>
      <div className="mo-kpi"><small>ELAPSED / MET</small><b>{up == null ? '—' : formatUptime(up)}</b></div>
    </div>
  )
}

/* ── EPS ── */
const POWER = [
  { key: 'OBC', ch: 'eps_pwr_obc', color: '#428cb8' },
  { key: 'COMMS', ch: 'eps_pwr_comms', color: '#cba25d' },
  { key: 'ADCS', ch: 'eps_pwr_adcs', color: '#8a77b4' },
  { key: 'TCS', ch: 'eps_pwr_tcs', color: '#53a38f' },
]

function EpsCard({ read }: { read: Read }) {
  const soc = read('eps_batt_soc')?.value
  const vals = POWER.map((p) => read(p.ch)?.value)
  const complete = vals.every((v) => v != null && v >= 0)
  const total = complete ? vals.reduce<number>((a, v) => a + v!, 0) : undefined
  let cursor = 0
  const stops = POWER.map((p, i) => {
    const start = cursor
    cursor += total ? (vals[i]! / total) * 100 : 0
    return `${p.color} ${start}% ${cursor}%`
  })
  return (
    <Card title="EPS SUMMARY" accent="#c7974f" tag={<Tag tone={soc == null ? 'off' : 'ok'}>SOC {soc == null ? '—' : `${soc.toFixed(0)}%`}</Tag>}>
      <div className="mo-capacity"><span>Battery state of charge</span><b>{soc == null ? '—' : `${soc.toFixed(1)} %`}</b></div>
      <div className="mo-track"><i style={{ width: `${Math.max(0, Math.min(100, soc ?? 0))}%` }} /></div>
      <div className="mo-power">
        <div className="mo-donut" style={{ background: total ? `conic-gradient(${stops.join(',')})` : 'var(--border-subtle)' }}>
          <div><b>{total == null ? '—' : `${total.toFixed(2)}W`}</b><small>TOTAL</small></div>
        </div>
        <div className="mo-legend">
          {POWER.map((p, i) => (
            <div key={p.key}>
              <i style={{ background: p.color }} />
              <span>{p.key}</span>
              <b>{total && vals[i] != null ? `${((vals[i]! / total) * 100).toFixed(0)}%` : '—'}</b>
              <em>{fmt(vals[i], 2, 'W')}</em>
            </div>
          ))}
        </div>
      </div>
      <div className="mo-tiles mo-tiles-3">
        <Tile label="VBATT" value={fmt(read('eps_batt_voltage')?.value, 2, 'V')} />
        <Tile label="IBATT" value={fmt(read('eps_batt_current')?.value, 2, 'A')} />
        <Tile label="VBUS" value={fmt(read('eps_bus_voltage')?.value, 2, 'V')} />
        <Tile label="IBUS" value={fmt(read('eps_bus_current')?.value, 2, 'A')} />
        <Tile label="5V / 3.3V RAILS" value="—" />
        <Tile label="BATT TEMP" value={fmt(read('eps_batt_temp')?.value, 1, '°C')} />
      </div>
    </Card>
  )
}

/* ── comms ── */
function Bars({ level }: { level: number | null }) {
  return (
    <span className="mo-bars" aria-hidden>
      {[1, 2, 3, 4].map((k) => <i key={k} className={level != null && level >= k ? 'on' : ''} style={{ height: 3 + k * 3 }} />)}
    </span>
  )
}

function CommsCard({ read }: { read: Read }) {
  const rssi = read('coms_rssi')?.value
  const snr = read('coms_snr')?.value
  const tx = read('coms_tx_duration')
  // signal-strength bars derived from the measured values, not decoration
  const rssiLvl = rssi == null ? null : rssi > -80 ? 4 : rssi > -95 ? 3 : rssi > -110 ? 2 : 1
  const snrLvl = snr == null ? null : snr > 15 ? 4 : snr > 10 ? 3 : snr > 5 ? 2 : 1
  return (
    <Card title="COMMS SUMMARY" accent="#4b9d98" tag={<Tag tone={rssi == null ? 'off' : 'ok'}>{rssi == null ? 'NO DATA' : 'RECEIVING'}</Tag>}>
      <div className="mo-tiles mo-tiles-2 mo-fill">
        <div className="mo-tile"><small>UPLINK RATE</small><b>{fmt(read('coms_uplink_rate')?.value, 0, 'bps')}</b></div>
        <div className="mo-tile"><small>DOWNLINK RATE</small><b>{fmt(read('coms_downlink_rate')?.value, 0, 'bps')}</b></div>
        <div className="mo-tile"><small>RSSI</small><b>{fmt(rssi, 1, 'dBm')}</b><Bars level={rssiLvl} /></div>
        <div className="mo-tile"><small>SNR</small><b style={{ color: snr != null ? '#23866d' : undefined }}>{snr == null ? '—' : `${snr >= 0 ? '+' : ''}${snr.toFixed(1)} dB`}</b><Bars level={snrLvl} /></div>
      </div>
      <div className="mo-foot">
        <span>Last TX: <b>{tx ? new Date(tx.ts * 1000).toISOString().slice(11, 19) + ' UTC' : '—'}</b></span>
        <span>BER: <b>{fmt(read('coms_ber')?.value, 5)}</b></span>
        <Link to="/dashboard/comms">RF workspace →</Link>
      </div>
    </Card>
  )
}

/* ── attitude ── */
type Vec = [number, number, number]

function quatToEuler(w: number, x: number, y: number, z: number) {
  const D = 180 / Math.PI
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * D,
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * D,
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * D,
  }
}

function AttitudeCard({ read }: { read: Read }) {
  const q = ['w', 'x', 'y', 'z'].map((a) => read(`adcs_quat_${a}`)?.value)
  const norm = Math.hypot(...q.map((v) => v ?? 0))
  const valid = q.every((v) => v != null) && norm > 1e-8
  const [yaw, setYaw] = useState(0.35)
  const [wire, setWire] = useState(false)
  const drag = useRef<number | null>(null)
  const [qw, qx, qy, qz] = valid ? q.map((v) => v! / norm) : [1, 0, 0, 0]
  const rot = ([x, y, z]: Vec): Vec => [
    (1 - 2 * (qy * qy + qz * qz)) * x + 2 * (qx * qy - qw * qz) * y + 2 * (qx * qz + qw * qy) * z,
    2 * (qx * qy + qw * qz) * x + (1 - 2 * (qx * qx + qz * qz)) * y + 2 * (qy * qz - qw * qx) * z,
    2 * (qx * qz - qw * qy) * x + 2 * (qy * qz + qw * qx) * y + (1 - 2 * (qx * qx + qy * qy)) * z,
  ]
  const project = (v: Vec) => {
    const [x, y, z] = rot(v)
    const xx = x * Math.cos(yaw) + z * Math.sin(yaw), zz = -x * Math.sin(yaw) + z * Math.cos(yaw)
    return [200 + xx * 42, 105 - (y * 0.94 - zz * 0.34) * 42, y * 0.34 + zz * 0.94]
  }
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, fill: string, edge: string) => {
    const v: Vec[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
    return [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [1, 5, 6, 2], [0, 3, 7, 4]].map((f) => ({ p: f.map((n) => project(v[n])), fill, edge }))
  }
  const faces = [
    ...box(-0.42, 0.42, -0.75, 0.75, -0.42, 0.42, '#36434f', '#f49b19'),
    ...box(-2.4, -0.48, -0.05, 0.05, -0.55, 0.55, '#1d5ea8', '#d98b19'),
    ...box(0.48, 2.4, -0.05, 0.05, -0.55, 0.55, '#1d5ea8', '#d98b19'),
  ].sort((a, b) => b.p.reduce((s, p) => s + p[2], 0) - a.p.reduce((s, p) => s + p[2], 0))
  const e = valid ? quatToEuler(qw, qx, qy, qz) : null
  const err = read('adcs_attitude_error')?.value
  const rate = ['x', 'y', 'z'].map((a) => read(`adcs_ang_vel_${a}`)?.value)
  const rateMag = rate.every((v) => v != null) ? Math.hypot(...(rate as number[])) : undefined
  const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`
  return (
    <Card title="3D ATTITUDE · CUBESAT 3U" accent="#658ba9" right={<><button onClick={() => setWire(!wire)} aria-pressed={wire}>Wireframe</button><button onClick={() => setYaw(0.35)}>Center</button></>}>
      <div className="mo-viewer"
        onPointerDown={(ev) => { drag.current = ev.clientX; ev.currentTarget.setPointerCapture(ev.pointerId) }}
        onPointerMove={(ev) => { if (drag.current != null) { setYaw((y) => y + (ev.clientX - drag.current!) * 0.01); drag.current = ev.clientX } }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <div className="mo-earth" />
        <svg viewBox="0 0 400 210" preserveAspectRatio="xMidYMid meet" role="img" aria-label={valid ? 'Attitude from received quaternion' : 'Model preview, no recent attitude telemetry'}>
          {faces.map((f, i) => <polygon key={i} points={f.p.map((p) => `${p[0]},${p[1]}`).join(' ')} fill={wire ? 'none' : f.fill} stroke={f.edge} strokeWidth="1.2" />)}
        </svg>
        <div className="mo-hud">{e ? `● R: ${sign(e.roll)}   ● P: ${sign(e.pitch)}   ● Y: ${sign(e.yaw)}` : '● R: —   ● P: —   ● Y: —'}</div>
        <div className={`mo-hud mo-hud2 ${valid ? 'on' : ''}`}>{valid ? '● RECEIVED QUATERNION' : '● MODEL PREVIEW · NO ATTITUDE DATA'}</div>
        <div className="mo-axes">+X Roll   +Y Pitch   +Z Yaw</div>
      </div>
      <div className="mo-attfoot">
        <div>ATT. ERROR <b>{fmt(err, 2, '°')}</b></div>
        <div>SUN ANGLE <b>{fmt(read('adcs_sun_angle')?.value, 1, '°')}</b></div>
        <div>BODY RATE <b>{fmt(rateMag, 3, '°/s')}</b></div>
      </div>
    </Card>
  )
}

/* ── ADCS ── */
function AdcsCard({ read }: { read: Read }) {
  const err = read('adcs_attitude_error')?.value
  const q = ['w', 'x', 'y', 'z'].map((a) => read(`adcs_quat_${a}`)?.value)
  return (
    <Card title="ADCS HARDWARE" accent="#658ba9" tag={<Tag tone={err == null ? 'off' : 'info'}>{err == null ? 'NO DATA' : `ERROR ${err.toFixed(2)}°`}</Tag>}>
      <div className="mo-sub">REACTION WHEELS (RPM)</div>
      <div className="mo-wheels">
        {[1, 2, 3].map((n) => {
          const v = read(`adcs_rw_speed_${n}`)?.value
          return (
            <div key={n} className="mo-wheel">
              <small>RW{n}</small>
              <b>{v == null ? '—' : v.toFixed(0)}</b>
              <span className={v == null ? '' : Math.abs(v) > 1 ? 'en' : 'idle'}>{v == null ? 'NO DATA' : Math.abs(v) > 1 ? 'SPINNING' : 'IDLE'}</span>
            </div>
          )
        })}
        <div className="mo-wheel"><small>TORQUE</small><b>{fmt(read('adcs_rw_torque')?.value, 4)}</b><span>mN·m</span></div>
      </div>
      <div className="mo-row"><span>Magnetorquer current</span><b>{fmt(read('adcs_mtq_current')?.value, 1, 'mA')}</b></div>
      <div className="mo-row"><span>Quaternion</span><b>{q.every((v) => v != null) ? `[${q.map((v) => v!.toFixed(3)).join(', ')}]` : '[ —, —, —, — ]'}</b></div>
      <div className="mo-row"><span>Sun angle</span><b style={{ color: '#ac874c' }}>{fmt(read('adcs_sun_angle')?.value, 1, '°')}</b></div>
    </Card>
  )
}

/* ── payload ── */
function PayloadCard() {
  const [images, setImages] = useState<ImageInfo[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = () => api.images().then((r) => { if (alive) { setImages([...r.images].sort((a, b) => b.modified - a.modified)); setError(false) } }).catch(() => { if (alive) setError(true) })
    refresh()
    const id = setInterval(refresh, 10000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  const last = images[0]
  return (
    <Card title="PAYLOAD · CAMERA" accent="#8a74b0" tag={<Tag tone={last ? 'ok' : 'off'}>{last ? 'LAST FRAME' : 'NO IMAGE'}</Tag>}>
      <div className="mo-payload">
        <div className="mo-camera">
          {last ? <img src={api.imageURL(last.filename)} alt={`Last received payload image ${last.filename}`} /> : <span className="mo-camera-empty">{error ? 'IMAGE SERVICE UNAVAILABLE' : 'NO IMAGE RECEIVED'}</span>}
          <div className="mo-camtop">STREAM [CAM-01]<span>{last ? '● RECEIVED' : '○ IDLE'}</span></div>
          {last && <div className="mo-cambottom">{last.filename} · {(last.size_bytes / 1024).toFixed(1)} KB</div>}
        </div>
        <div className="mo-pinfo">
          <div className="mo-row"><span>Images received</span><b>{images.length}</b></div>
          <div className="mo-row"><span>Last image</span><b>{last ? new Date(last.modified * 1000).toISOString().slice(5, 16).replace('T', ' ') : '—'}</b></div>
          <div className="mo-row"><span>Sensor temp.</span><b>—</b></div>
          <div className="mo-row"><span>Focus position</span><b>—</b></div>
          <Link className="mo-shoot" to="/dashboard/payload">Open image viewer</Link>
        </div>
      </div>
    </Card>
  )
}

/* ── console ── */
function ConsoleCard() {
  const { logs, messages } = useTelemetry()
  const [cutoff, setCutoff] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => [
    ...logs.map((l) => ({ ts: l.ts, text: l.text, kind: 'log' })),
    ...messages.map((m) => ({ ts: m.ts, text: `RX ${m.satellite_id || '—'} · ${m.source} · ${m.pkt_type_name || m.pkt_type} · ${m.decoded ? 'decoded' : `error: ${m.error || '?'}`} · ${m.size_bytes} B`, kind: m.decoded ? 'ok' : 'err' })),
  ].filter((e) => e.ts > cutoff).sort((a, b) => a.ts - b.ts).slice(-120), [logs, messages, cutoff])
  const last = entries.at(-1)?.ts
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [last])
  return (
    <section className="mo-card mo-cmd">
      <div className="mo-head">
        <span className="mo-lights">●●●</span>
        <span className="mo-title">COMMAND CONSOLE · LIVE LOG</span>
        <span className="mo-right"><button onClick={() => setCutoff(Date.now() / 1000)}>Clear</button></span>
      </div>
      <div ref={list} className="mo-terminal" role="log" aria-live="polite">
        {entries.length ? entries.map((e, i) => (
          <div key={`${e.ts}-${i}`} className={e.kind}>[{new Date(e.ts * 1000).toISOString().slice(11, 19)}] {e.text}</div>
        )) : <div className="sys">Waiting for received data…</div>}
      </div>
      <div className="mo-cmdline">
        <span>IS-CMD&gt;</span>
        <input disabled placeholder="Read-only · commands are scheduled in Settings → Scheduling" aria-label="Command input (read-only)" />
        <Link to="/configuracion/programacion">Schedule</Link>
      </div>
    </section>
  )
}

/* ── solar ── */
function SolarCard({ read }: { read: Read }) {
  const total = read('eps_solar_total_power')?.value
  return (
    <Card title="SOLAR PANEL ARRAY · PHOTOVOLTAIC TELEMETRY" accent="#c7974f" right={<span className="mo-total">TOTAL POWER: <b>{fmt(total, 2, 'W')}</b></span>}>
      <div className="mo-solar">
        {[1, 2, 3, 4, 5, 6].map((n) => {
          const v = read(`eps_solar_voltage_${n}`)?.value, i = read(`eps_solar_current_${n}`)?.value, t = read(`tcs_panel_temp_${n}`)?.value
          const p = v != null && i != null ? v * i : undefined
          return (
            <div key={n} className="mo-panel">
              <div className="mo-panelhead">P{n}<span className={p != null && p > 0.01 ? 'act' : 'idle'}>{p == null ? '—' : p > 0.01 ? 'ACT' : 'IDLE'}</span></div>
              <div className="mo-pv"><span>V:</span><b>{fmt(v, 2, 'V')}</b></div>
              <div className="mo-pv"><span>I:</span><b>{fmt(i, 3, 'A')}</b></div>
              <div className="mo-pv"><span>T:</span><b>{fmt(t, 1, '°C')}</b></div>
              <div className="mo-pv mo-pw"><span>P:</span><b>{fmt(p, 2, 'W')}</b></div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ── thermal ── */
const RANGES = [{ label: '1h', min: 60 }, { label: '6h', min: 360 }, { label: '24h', min: 1440 }]

function ThermalCard({ read }: { read: Read }) {
  const [range, setRange] = useState(60)
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = () => api.history('sim.obc_temp', range).then((r) => { if (alive) { setPoints(r.points); setFailed(false) } }).catch(() => { if (alive) setFailed(true) })
    refresh()
    const id = setInterval(refresh, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [range])
  const panelTemps = [1, 2, 3, 4, 5, 6].map((n) => read(`tcs_panel_temp_${n}`)?.value).filter((v): v is number => v != null)
  const bars = [
    { key: 'OBC', v: read('obc_temp')?.value, color: '#8a77b4' },
    { key: 'BATT', v: read('eps_batt_temp')?.value, color: '#53a38f' },
    { key: 'PA', v: read('coms_pa_temp')?.value, color: '#428cb8' },
    { key: 'PANELS', v: panelTemps.length ? panelTemps.reduce((a, b) => a + b, 0) / panelTemps.length : undefined, color: '#cba25d' },
  ]
  const known = bars.map((b) => b.v).filter((v): v is number => v != null)
  const top = Math.max(10, ...known.map(Math.abs))
  const vals = points.map((p) => p.value)
  let path = '', area = ''
  if (vals.length > 1) {
    let lo = Math.min(...vals), hi = Math.max(...vals)
    if (lo === hi) { lo -= 1; hi += 1 }
    const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1
    const xy = points.map((p) => [((p.ts - t0) / (t1 - t0 || 1)) * 300, 92 - ((p.value - lo) / (hi - lo)) * 80])
    path = 'M' + xy.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' L')
    area = `${path} L300,100 L0,100 Z`
  }
  const last = points.at(-1)?.value
  return (
    <Card title="THERMAL & ALTITUDE" accent="#658ba9" right={<span className="mo-controls">{RANGES.map((r) => <button key={r.min} className={range === r.min ? 'sel' : ''} onClick={() => setRange(r.min)}>{r.label}</button>)}</span>}>
      <div className="mo-altbody">
        <div className="mo-chartcol">
          <div className="mo-ctitle"><span>OBC temperature history (°C)</span><b>{fmt(last, 1, '°C')}</b></div>
          <div className="mo-linechart">
            {path ? (
              <svg viewBox="0 0 300 100" preserveAspectRatio="none">
                <defs><linearGradient id="mo-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1597e4" stopOpacity=".3" /><stop offset="1" stopColor="#1597e4" stopOpacity=".02" /></linearGradient></defs>
                <path d={area} fill="url(#mo-area)" />
                <path d={path} fill="none" stroke="#128fdb" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : <span className="mo-empty">{failed ? 'History unavailable' : 'No samples in this range'}</span>}
          </div>
          <div className="mo-ctitle"><span>Orbital altitude</span><b>— · no source</b></div>
        </div>
        <div className="mo-chartcol">
          <div className="mo-ctitle"><span>Subsystem temperatures (°C)</span><b>{known.length ? 'LIVE' : 'NO DATA'}</b></div>
          <div className="mo-bars-chart">
            {bars.map((b) => (
              <div key={b.key} className="mo-bw">
                <div className="mo-bar" style={{ height: b.v == null ? 2 : `${Math.max(6, (Math.abs(b.v) / top) * 100)}%`, background: b.v == null ? 'var(--border-subtle)' : b.color }}>
                  {b.v != null && <em>{b.v.toFixed(0)}°</em>}
                </div>
                {b.key}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

export function Dashboard() {
  const read = useReadings()
  return (
    <div className="page mo-page">
      <OverviewStrip read={read} />
      <div className="mo-top">
        <div className="mo-col mo-col-left"><EpsCard read={read} /><CommsCard read={read} /></div>
        <div className="mo-col mo-col-center"><AttitudeCard read={read} /><AdcsCard read={read} /></div>
        <div className="mo-col mo-col-right"><PayloadCard /><ConsoleCard /></div>
      </div>
      <div className="mo-bottom"><SolarCard read={read} /><ThermalCard read={read} /></div>
    </div>
  )
}
