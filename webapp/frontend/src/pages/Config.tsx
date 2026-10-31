import { useEffect, useState } from 'react'
import { api, type CommandRef, type DetectedDevice, type ScheduleResponse, type SatelliteConfig } from '../api'
import { TransmitWarning } from '../components/TransmitWarning'

type Mode = 'recurring' | 'once'

function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const DRIVER_LABEL: Record<string, string> = {
  mcu: 'MCU (UART, RX/TX)',
  limesdr: 'LimeSDR (RX/TX)',
  rtlsdr: 'RTL-SDR (solo RX)',
}

const METHOD_OPTIONS = [
  { value: 'uart8a', label: 'UART 0x8A' },
  { value: 'ax25', label: 'AX.25' },
  { value: 'ccsds_spp', label: 'CCSDS SPP' },
]

function SatellitePanel({ onDriverChange }: { onDriverChange: (driver: string) => void }) {
  const [cfg, setCfg] = useState<SatelliteConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<DetectedDevice[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  async function handleScan() {
    setScanning(true)
    setScanError(null)
    try {
      setDevices(await api.scanDevices())
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    api
      .getSatellite()
      .then((c) => {
        setCfg(c)
        onDriverChange(c.reception.driver)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!cfg) return
    setError(null)
    setSaving(true)
    setSaved(false)
    try {
      const updated = await api.putSatellite(cfg)
      setCfg(updated)
      onDriverChange(updated.reception.driver)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!cfg) {
    return (
      <div className="panel">
        <div className="panel-title">Satélite y recepción</div>
        <p className="empty-note">Cargando…</p>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-title">Satélite y recepción</div>
      <p className="empty-note" style={{ marginBottom: 10 }}>
        El driver que guardes aquí es el que usa <code>headless_receiver.py</code> — necesita
        reiniciarse para tomar un cambio (no es en caliente).
      </p>
      <form onSubmit={handleSubmit} className="config-form">
        <label>
          ID del satélite
          <input
            type="text"
            value={cfg.satellite.id}
            onChange={(e) => setCfg({ ...cfg, satellite: { ...cfg.satellite, id: e.target.value } })}
            required
          />
        </label>
        <label>
          Nombre
          <input
            type="text"
            value={cfg.satellite.name}
            onChange={(e) => setCfg({ ...cfg, satellite: { ...cfg.satellite, name: e.target.value } })}
            required
          />
        </label>
        <div className="device-scan">
          <div className="device-scan-header">
            <span>
              Driver actual: <b>{DRIVER_LABEL[cfg.reception.driver] ?? cfg.reception.driver}</b>
            </span>
            <button type="button" className="mini-ctrl-btn accent" onClick={handleScan} disabled={scanning}>
              {scanning ? 'Buscando…' : 'Buscar equipos'}
            </button>
          </div>
          {scanError && <div className="config-error">{scanError}</div>}
          {devices.length === 0 ? (
            <p className="empty-note" style={{ fontSize: 10.5 }}>
              {scanning ? 'Escaneando USB y puertos serie…' : 'Sin escanear todavía. Detecta lo que está realmente conectado (USB para LimeSDR/RTL-SDR, puertos serie para MCU) en vez de elegirlo a ciegas.'}
            </p>
          ) : (
            <div className="device-scan-list">
              {devices.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  className={cfg.reception.driver === d.driver ? 'device-scan-row selected' : 'device-scan-row'}
                  onClick={() => setCfg({ ...cfg, reception: { ...cfg.reception, driver: d.driver } })}
                >
                  <span className="dsr-label">{d.label}</span>
                  <span className="dsr-detail">{d.detail}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <label>
          Método (protocolo/framing)
          <select
            value={cfg.reception.method}
            onChange={(e) => setCfg({ ...cfg, reception: { ...cfg.reception, method: e.target.value } })}
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modulación
          <input
            type="text"
            value={cfg.reception.modulation}
            onChange={(e) => setCfg({ ...cfg, reception: { ...cfg.reception, modulation: e.target.value } })}
          />
        </label>
        <label>
          Frecuencia (MHz)
          <input
            type="number"
            step="0.001"
            value={cfg.reception.frequency_mhz}
            onChange={(e) => setCfg({ ...cfg, reception: { ...cfg.reception, frequency_mhz: Number(e.target.value) } })}
          />
        </label>
        <label>
          Ganancia (dB)
          <input
            type="number"
            step="1"
            value={cfg.reception.gain_db}
            onChange={(e) => setCfg({ ...cfg, reception: { ...cfg.reception, gain_db: Number(e.target.value) } })}
          />
        </label>
        <label>
          Sync word
          <input
            type="text"
            value={cfg.reception.sync_word}
            onChange={(e) => setCfg({ ...cfg, reception: { ...cfg.reception, sync_word: e.target.value } })}
          />
        </label>

        {error && <div className="config-error">{error}</div>}
        <button type="submit" disabled={saving}>
          {saving ? 'Guardando…' : saved ? 'Guardado ✓' : 'Guardar'}
        </button>
      </form>
    </div>
  )
}

function DecoderFilePanel() {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleView() {
    if (content !== null) {
      setContent(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(api.decoderFileURL())
      if (!res.ok) throw new Error(`${res.status}`)
      setContent(await res.text())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">Archivo de desdoblamiento</div>
      <p className="empty-note" style={{ marginBottom: 16 }}>
        <code>Core/SDR/telemetry_assembler.py</code> define cómo se parten los bytes crudos en
        variables. Se puede ver o descargar; el reemplazo todavía no tiene lógica implementada.
      </p>
      <div className="filter-row" style={{ marginBottom: content ? 12 : 0 }}>
        <button type="button" onClick={handleView} disabled={loading}>
          {loading ? 'Cargando…' : content !== null ? 'Ocultar' : 'Ver contenido'}
        </button>
        <a href={api.decoderFileURL()} download="telemetry_assembler.py">
          <button type="button">Descargar</button>
        </a>
        <button type="button" disabled title="Próximamente">
          Reemplazar archivo (próximamente)
        </button>
      </div>
      {error && <div className="config-error">{error}</div>}
      {content !== null && <pre className="decoder-file-view">{content}</pre>}
    </div>
  )
}

export function Config() {
  const [commands, setCommands] = useState<CommandRef[]>([])
  const [schedule, setSchedule] = useState<ScheduleResponse>({ recurring: [], once: [] })
  const [driver, setDriver] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<Mode>('recurring')
  const [command, setCommand] = useState('')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [intervalS, setIntervalS] = useState(300)
  const [fireAt, setFireAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    api.schedule().then(setSchedule).catch(() => {})
  }

  useEffect(() => {
    api.commands().then((r) => {
      setCommands(r.commands)
      if (r.commands.length) setCommand(r.commands[0].name)
    }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [])

  const selected = commands.find((c) => c.name === command)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      if (mode === 'recurring') {
        if (!windowStart || !windowEnd) throw new Error('Completá la ventana de inicio y fin')
        await api.addRecurring({
          command,
          window_start: new Date(windowStart).toISOString(),
          window_end: new Date(windowEnd).toISOString(),
          interval_s: intervalS,
          enabled: true,
        })
      } else {
        if (!fireAt) throw new Error('Completá la fecha/hora')
        await api.addOnce({
          command,
          fire_at: new Date(fireAt).toISOString(),
          enabled: true,
        })
      }
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(kind: Mode, id: string) {
    await api.deleteSchedule(kind, id)
    refresh()
  }

  return (
    <div className="page config-page">
      <h2>Configuración</h2>

      <div className="two-col-grid" style={{ alignItems: 'start' }}>
        <div>
          <SatellitePanel onDriverChange={setDriver} />
          <DecoderFilePanel />
        </div>
        <div>
          <TransmitWarning schedule={schedule} driver={driver} />
          <div className="panel">
            <div className="panel-title">Programar comando</div>
            <form onSubmit={handleSubmit} className="config-form">
              <label>
                Comando
                <select value={command} onChange={(e) => setCommand(e.target.value)}>
                  {commands.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {selected && <div className="config-hint">{selected.syntax} — {selected.description}</div>}

              <div className="config-mode-toggle">
                <button type="button" className={mode === 'recurring' ? 'active' : ''} onClick={() => setMode('recurring')}>
                  Recurrente
                </button>
                <button type="button" className={mode === 'once' ? 'active' : ''} onClick={() => setMode('once')}>
                  Una sola vez
                </button>
              </div>

              {mode === 'recurring' ? (
                <>
                  <label>
                    Desde
                    <input type="datetime-local" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
                  </label>
                  <label>
                    Hasta
                    <input type="datetime-local" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} required />
                  </label>
                  <label>
                    Cada (segundos)
                    <input type="number" min={1} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} required />
                  </label>
                </>
              ) : (
                <label>
                  Cuándo
                  <input type="datetime-local" value={fireAt} onChange={(e) => setFireAt(e.target.value)} required />
                </label>
              )}

              {error && <div className="config-error">{error}</div>}
              <button type="submit" disabled={saving}>
                {saving ? 'Guardando…' : 'Programar'}
              </button>
            </form>
          </div>
        </div>
      </div>

      <div className="two-col-grid">
        <div className="panel">
          <div className="panel-title">Ventanas recurrentes</div>
          {schedule.recurring.length === 0 && <div className="empty-note">Nada programado.</div>}
          {schedule.recurring.map((e) => (
            <div key={e.id} className="schedule-row">
              <div>
                <strong>{e.command}</strong>
                <span className="schedule-meta">
                  {toLocalInputValue(e.window_start)} → {toLocalInputValue(e.window_end)} · cada {e.interval_s}s
                  {e.last_fired_at && ` · último disparo ${toLocalInputValue(e.last_fired_at)}`}
                </span>
              </div>
              <button type="button" onClick={() => handleDelete('recurring', e.id)}>
                Quitar
              </button>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-title">Una sola vez</div>
          {schedule.once.length === 0 && <div className="empty-note">Nada programado.</div>}
          {schedule.once.map((e) => (
            <div key={e.id} className="schedule-row">
              <div>
                <strong>{e.command}</strong>
                <span className="schedule-meta">
                  {toLocalInputValue(e.fire_at)} {e.fired ? '· ya disparado' : '· pendiente'}
                </span>
              </div>
              <button type="button" onClick={() => handleDelete('once', e.id)}>
                Quitar
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
