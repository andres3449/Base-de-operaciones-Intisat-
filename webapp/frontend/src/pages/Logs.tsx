import { useEffect, useMemo, useState } from 'react'
import { useTelemetry } from '../telemetry/TelemetryContext'
import { api, type HistoryPoint, type ImageInfo, type MessageEntry } from '../api'

function fromLocalInputValue(v: string): number | undefined {
  return v ? new Date(v).getTime() / 1000 : undefined
}

type LiveItem = { ts: number; text: string; badge: 'log' | 'msg' }

function LivePanel() {
  const { logs, messages } = useTelemetry()

  const items = useMemo<LiveItem[]>(() => {
    const fromLogs: LiveItem[] = logs.map((l) => ({ ts: l.ts, text: l.text, badge: 'log' }))
    const fromMsgs: LiveItem[] = messages.map((m) => ({
      ts: m.ts,
      text: `${m.source} · ${m.pkt_type_name || `type ${m.pkt_type}`} · ${m.decoded ? 'decodificado' : `error: ${m.error || '?'}`} · ${m.size_bytes}B`,
      badge: 'msg',
    }))
    return [...fromLogs, ...fromMsgs].sort((a, b) => b.ts - a.ts).slice(0, 150)
  }, [logs, messages])

  return (
    <div className="panel logs-live-panel">
      <div className="panel-title">Log en vivo</div>
      {items.length === 0 ? (
        <p className="empty-note">Sin actividad todavía.</p>
      ) : (
        <div className="logs-live-list">
          {items.map((it, i) => (
            <div key={i} className={`logs-live-row logs-live-row-${it.badge}`}>
              <span className="logs-live-ts">{new Date(it.ts * 1000).toLocaleTimeString()}</span>
              <span className="logs-live-text">{it.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LastImagePanel() {
  const [images, setImages] = useState<ImageInfo[]>([])

  useEffect(() => {
    const refresh = () => api.images().then((r) => setImages(r.images)).catch(() => {})
    refresh()
    const id = setInterval(refresh, 10000)
    return () => clearInterval(id)
  }, [])

  const latest = [...images].sort((a, b) => b.modified - a.modified)[0]

  return (
    <div className="panel logs-image-panel">
      <div className="panel-title">Última imagen recibida</div>
      {!latest ? (
        <p className="empty-note">Todavía no llegó ninguna imagen.</p>
      ) : (
        <a href={api.imageURL(latest.filename)} target="_blank" rel="noreferrer" className="logs-image-link">
          <img src={api.imageURL(latest.filename)} alt={latest.filename} />
          <div className="image-card-meta">
            <span>{new Date(latest.modified * 1000).toLocaleString()}</span>
            <span>{(latest.size_bytes / 1024).toFixed(1)} KB</span>
          </div>
        </a>
      )}
    </div>
  )
}

function MessagesPanel() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [satelliteId, setSatelliteId] = useState('')
  const [pktType, setPktType] = useState('')
  const [source, setSource] = useState('')
  const [decoded, setDecoded] = useState<'any' | 'yes' | 'no'>('any')
  const [rows, setRows] = useState<MessageEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = () => {
    setLoading(true)
    api
      .messages({
        from_ts: fromLocalInputValue(from),
        to_ts: fromLocalInputValue(to),
        satellite_id: satelliteId || undefined,
        pkt_type: pktType ? Number(pktType) : undefined,
        source: source || undefined,
        decoded: decoded === 'any' ? undefined : decoded === 'yes',
        limit: 200,
      })
      .then((r) => setRows(r.messages))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="panel">
      <div className="panel-title">Mensajes recibidos</div>
      <div className="filter-row">
        <label>
          Desde
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Hasta
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Satélite
          <input type="text" value={satelliteId} onChange={(e) => setSatelliteId(e.target.value)} placeholder="INTISAT-1" />
        </label>
        <label>
          Tipo de paquete
          <input type="number" value={pktType} onChange={(e) => setPktType(e.target.value)} placeholder="Cualquiera" />
        </label>
        <label>
          Origen
          <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="mcu" />
        </label>
        <label>
          Decodificado
          <select value={decoded} onChange={(e) => setDecoded(e.target.value as 'any' | 'yes' | 'no')}>
            <option value="any">Cualquiera</option>
            <option value="yes">Sí</option>
            <option value="no">No</option>
          </select>
        </label>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Buscando…' : 'Aplicar filtros'}
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Satélite</th>
              <th>Origen</th>
              <th>Tipo</th>
              <th>Decodificado</th>
              <th>Error</th>
              <th>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-note">
                  Sin mensajes para este filtro.
                </td>
              </tr>
            )}
            {rows.map((m, i) => (
              <tr key={i}>
                <td>{new Date(m.ts * 1000).toLocaleString()}</td>
                <td>{m.satellite_id || '—'}</td>
                <td>{m.source}</td>
                <td>{m.pkt_type_name || m.pkt_type}</td>
                <td className={m.decoded ? 'ok-text' : 'bad-text'}>{m.decoded ? 'Sí' : 'No'}</td>
                <td>{m.error || '—'}</td>
                <td>{m.size_bytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VariablesPanel() {
  const [channels, setChannels] = useState<string[]>([])
  const [channel, setChannel] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [satelliteId, setSatelliteId] = useState('')
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api
      .channels()
      .then((r) => {
        setChannels(r.channels)
        if (r.channels.length) setChannel(r.channels[0])
      })
      .catch(() => {})
  }, [])

  const refresh = () => {
    if (!channel) return
    setLoading(true)
    api
      .history(channel, { from_ts: fromLocalInputValue(from), to_ts: fromLocalInputValue(to) }, satelliteId || undefined)
      .then((r) => setPoints(r.points))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel])

  return (
    <div className="panel">
      <div className="panel-title">Variables decodificadas</div>
      <div className="filter-row">
        <label>
          Canal
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Desde
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Hasta
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Satélite
          <input type="text" value={satelliteId} onChange={(e) => setSatelliteId(e.target.value)} placeholder="INTISAT-1" />
        </label>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Buscando…' : 'Aplicar filtros'}
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Valor</th>
            </tr>
          </thead>
          <tbody>
            {points.length === 0 && (
              <tr>
                <td colSpan={2} className="empty-note">
                  Sin datos para este filtro.
                </td>
              </tr>
            )}
            {points
              .slice()
              .reverse()
              .slice(0, 200)
              .map((p, i) => (
                <tr key={i}>
                  <td>{new Date(p.ts * 1000).toLocaleString()}</td>
                  <td>{p.value}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function Logs() {
  return (
    <div className="page">
      <h2>Logs y tablas</h2>

      <div className="logs-top-row">
        <LivePanel />
        <LastImagePanel />
      </div>

      <MessagesPanel />
      <VariablesPanel />
    </div>
  )
}
