import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type ImageInfo } from '../api'
import { useTelemetry } from '../telemetry/TelemetryContext'

export function Panel({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`mission-panel ${className}`}><h2>{title}</h2>{children}</section>
}

// A missing, nonfinite or older-than-30s reading is never shown as current.
export function useReadings() {
  const { live } = useTelemetry()
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  return (channel: string) => {
    const reading = live[channel.startsWith('sim.') ? channel : `sim.${channel}`]
    return reading && Number.isFinite(reading.value) && now / 1000 - reading.ts <= 30 && reading.ts <= now / 1000 + 5 ? reading : undefined
  }
}

export function Metric({ label, channel, unit = '', decimals = 2 }: { label: string; channel?: string; unit?: string; decimals?: number }) {
  const read = useReadings()
  const value = channel ? read(channel) : undefined
  return <div className="mission-metric" title={value ? `Received ${new Date(value.ts * 1000).toISOString()}` : 'No recent telemetry'}><span>{label}</span><b>{value ? `${value.value.toFixed(decimals)} ${unit}` : '—'}</b></div>
}

export function DataState() {
  const { wsConnected, status } = useTelemetry()
  const fresh = status?.seconds_since_last_frame != null && status.seconds_since_last_frame <= 30
  return <div className="mission-state"><span className={`status-dot ${wsConnected && fresh ? 'ok' : 'bad'}`} />{!wsConnected ? 'Disconnected' : fresh ? 'Receiving telemetry' : 'Connected · waiting for telemetry'}<span className="mono">Last frame: {status?.last_frame_ts ? new Date(status.last_frame_ts * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—'}</span></div>
}

export function PowerDistribution() {
  const read = useReadings()
  const parts = [['OBC', 'eps_pwr_obc', 'var(--accent-cyan)'], ['COMMS', 'eps_pwr_comms', 'var(--eps-accent)'], ['ADCS', 'eps_pwr_adcs', 'var(--payload-accent)'], ['TCS', 'eps_pwr_tcs', 'var(--green-on)']]
  const values = parts.map(([, ch]) => read(ch)?.value)
  const complete = values.every(v => v != null && v >= 0)
  const total = complete ? values.reduce<number>((s, v) => s + v!, 0) : undefined
  let cursor = 0
  const stops = values.map((v, i) => { const start = cursor; cursor += total ? v! / total * 100 : 0; return `${parts[i][2]} ${start}% ${cursor}%` })
  return <div className="mission-power"><div className="mission-donut" style={{ background: total ? `conic-gradient(${stops.join(',')})` : 'var(--border-subtle)' }}><div><b>{total == null ? '—' : `${total.toFixed(2)} W`}</b><small>TOTAL</small></div></div><div>{parts.map(([label, channel, color]) => <div key={channel} style={{ borderLeft: `3px solid ${color}`, paddingLeft: 8 }}><Metric label={label} channel={channel} unit="W" /></div>)}</div></div>
}

export function SolarPanels() {
  return <div className="mission-solar">{Array.from({ length: 6 }, (_, i) => i + 1).map(n => <div key={n}><strong>P{n}</strong><Metric label="Voltage" channel={`eps_solar_voltage_${n}`} unit="V" /><Metric label="Current" channel={`eps_solar_current_${n}`} unit="A" /><Metric label="Temp." channel={`tcs_panel_temp_${n}`} unit="°C" decimals={1} /></div>)}</div>
}

export function PacketConsole({ title = 'MISSION TERMINAL', sdrOnly = false }: { title?: string; sdrOnly?: boolean }) {
  const { logs, messages } = useTelemetry()
  const [paused, setPaused] = useState(false)
  const [cutoff, setCutoff] = useState(0)
  const [query, setQuery] = useState('')
  const [auto, setAuto] = useState(true)
  const [frozen, setFrozen] = useState<{ ts: number; text: string }[]>([])
  const list = useRef<HTMLDivElement>(null)
  const entries = [...logs, ...messages.filter(m => !sdrOnly || m.source === 'sdr').map(m => ({ ts: m.ts, text: `${m.source} · ${m.pkt_type_name || m.pkt_type} · ${m.decoded ? 'decoded' : `error: ${m.error}`} · ${m.size_bytes} B` }))].sort((a, b) => a.ts - b.ts).slice(-200)
  const visible = (paused ? frozen : entries).filter(e => e.ts > cutoff && e.text.toLowerCase().includes(query.toLowerCase()))
  const last = visible.at(-1)?.ts
  useEffect(() => { if (auto && list.current) list.current.scrollTop = list.current.scrollHeight }, [last, auto])
  return <Panel title={title} className="mission-console"><div className="mission-tools"><input aria-label="Filter console" placeholder="Filter packets…" value={query} onChange={e => setQuery(e.target.value)} /><button onClick={() => { if (!paused) setFrozen(entries); setPaused(!paused) }}>{paused ? 'Resume' : 'Pause'}</button><button onClick={() => setCutoff(Date.now() / 1000)}>Clear</button><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />Scroll</label></div><div ref={list} className="mission-terminal" role="log">{visible.length ? visible.map((e, i) => <div key={`${e.ts}-${i}`}><time>{new Date(e.ts * 1000).toISOString().slice(11, 19)} UTC</time> {e.text}</div>) : <p>Waiting for received data…</p>}</div></Panel>
}

export function PayloadImage({ compact = false }: { compact?: boolean }) {
  const [images, setImages] = useState<ImageInfo[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    let active = true
    const refresh = async () => { try { const data = await api.images(); if (active) { setImages(data.images.sort((a, b) => b.modified - a.modified)); setError('') } } catch { if (active) setError('Image service unavailable') } }
    void refresh(); const id = setInterval(refresh, 10000)
    return () => { active = false; clearInterval(id) }
  }, [])
  const current = images.find(i => i.filename === selected) ?? images[0]
  return <div className="mission-image"><div className="mission-image-view" onPointerDown={e => { drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if (drag.current) setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
    {current ? <img draggable={false} src={api.imageURL(current.filename)} alt={`Received payload: ${current.filename}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} /> : <div className="mission-empty">NO IMAGE RECEIVED</div>}
    {error && <span className="mission-image-caption" role="alert">{error}</span>}
  </div>{!compact && <div className="mission-tools"><select aria-label="Received image" value={current?.filename ?? ''} onChange={e => { setSelected(e.target.value); setZoom(1); setPan({ x: 0, y: 0 }) }}><option value="" disabled>Select received image</option>{images.map(i => <option key={i.filename}>{i.filename}</option>)}</select><button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.25, z / 1.25))}>−</button><button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(8, z * 1.25))}>+</button><button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Fit</button>{current && <a className="mission-primary" href={api.imageURL(current.filename)} download>Download image</a>}</div>}{current && <small>{current.filename} · {(current.size_bytes / 1024).toFixed(1)} KB · {new Date(current.modified * 1000).toISOString()}</small>}</div>
}

type Vec = [number, number, number]
export function AttitudeView() {
  const read = useReadings()
  const q = ['w', 'x', 'y', 'z'].map(a => read(`adcs_quat_${a}`)?.value)
  const norm = Math.hypot(...q.map(v => v ?? 0))
  const valid = q.every(v => v != null) && norm > 1e-8
  const [yaw, setYaw] = useState(.5)
  const [zoom, setZoom] = useState(1)
  const [wire, setWire] = useState(false)
  const drag = useRef<number | null>(null)
  const rotate = ([x, y, z]: Vec): Vec => {
    if (!valid) return [x, y, z]
    const [w, a, b, c] = q.map(v => v! / norm)
    return [(1-2*(b*b+c*c))*x+2*(a*b-w*c)*y+2*(a*c+w*b)*z,2*(a*b+w*c)*x+(1-2*(a*a+c*c))*y+2*(b*c-w*a)*z,2*(a*c-w*b)*x+2*(b*c+w*a)*y+(1-2*(a*a+b*b))*z]
  }
  const project = (v: Vec) => { const [x, y, z] = rotate(v); const xx = x*Math.cos(yaw)+z*Math.sin(yaw), zz = -x*Math.sin(yaw)+z*Math.cos(yaw); return [200+xx*46*zoom, 125-(y*.94-zz*.34)*46*zoom, y*.34+zz*.94] }
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const v: Vec[] = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]
    return [[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[1,5,6,2],[0,3,7,4]].map((f, i) => ({ points: f.map(n => project(v[n])), color: ['#193b61','#234c71','#132b45'][i%3] }))
  }
  const faces = [...box(-.45,.45,-1.2,1.2,-.45,.45), ...box(-2.7,-.5,-.32,-.22,-.65,.65), ...box(.5,2.7,-.32,-.22,-.65,.65)].sort((a,b) => b.points.reduce((s,p)=>s+p[2],0)-a.points.reduce((s,p)=>s+p[2],0))
  return <div className="mission-attitude"><div className="mission-tools"><button onClick={() => { setYaw(.5); setZoom(1) }}>Center</button><button aria-pressed={wire} onClick={() => setWire(!wire)}>Wireframe</button><button aria-label="Zoom model in" onClick={() => setZoom(z => Math.min(1.4,z+.1))}>+</button><button aria-label="Zoom model out" onClick={() => setZoom(z => Math.max(.5,z-.1))}>−</button></div><svg viewBox="0 0 400 250" role="img" aria-label={valid ? 'Attitude from received quaternion; drag to change camera' : 'Model preview; no recent attitude telemetry'} onPointerDown={e => { drag.current=e.clientX; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if(drag.current!=null){setYaw(y=>y+(e.clientX-drag.current!)*.01);drag.current=e.clientX} }} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}><defs><pattern id="attitude-grid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#24415b" strokeWidth=".4" /></pattern></defs><rect width="400" height="250" fill="url(#attitude-grid)" />{faces.map((f,i)=><polygon key={i} points={f.points.map(p=>`${p[0]},${p[1]}`).join(' ')} fill={wire?'none':f.color} stroke="#cbab64" strokeWidth="1" />)}<text x="12" y="22" fill="#a5c9e7" fontSize="10">{valid?'RECEIVED QUATERNION':'MODEL PREVIEW · NO RECENT ATTITUDE'}</text><text x="12" y="235" fill="#a5c9e7" fontSize="9">X · ROLL    Y · PITCH    Z · YAW</text></svg></div>
}
