import { useEffect, useMemo, useState } from 'react'
import { api, type SatelliteConfig } from '../api'
import { useTelemetry } from '../telemetry/TelemetryContext'
import { SpectrumScope } from '../components/SpectrumScope'

// Fixed values from Core/SDR/sdr_backend_client.py's SDRConfig defaults —
// not yet exposed as per-satellite config, so shown as read-only info
// (matches what the real PyQt SDR Spectrum tab shows for the same fields).
const FIXED_DEMOD = { bandwidth_hz: 30000, symbol_rate_sps: 9600, freq_dev_hz: 5000 }

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="field-row">
      <span className="fl">{label}</span>
      <span className="fv">{value}</span>
    </div>
  )
}

interface WaterfallRangeProps {
  dbMin: number
  dbMax: number
  onChange: (next: { dbMin: number; dbMax: number }) => void
}

function DeviceSettingsColumn({ dbMin, dbMax, onChange }: WaterfallRangeProps) {
  const { status } = useTelemetry()
  const [cfg, setCfg] = useState<SatelliteConfig | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [restartMsg, setRestartMsg] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => api.getSatellite().then(setCfg).catch(() => {})
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [])

  const driverLabel: Record<string, string> = { mcu: 'MCU (UART)', limesdr: 'LimeSDR', rtlsdr: 'RTL-SDR' }

  async function handleRestart() {
    setRestarting(true)
    setRestartMsg(null)
    try {
      await api.restartSdr()
      setRestartMsg('Reiniciando — el dispositivo se vuelve a abrir y calibrar, puede tardar ~10s.')
    } catch (err) {
      setRestartMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="sdr-diag-side">
      <div className="pyqt-panel">
        <div className="panel-title" style={{ justifyContent: 'space-between' }}>
          <span>Dispositivo</span>
          <button type="button" className="mini-ctrl-btn accent" onClick={handleRestart} disabled={restarting}>
            {restarting ? 'Reiniciando…' : 'Reiniciar backend SDR'}
          </button>
        </div>
        <InfoRow label="Driver" value={cfg ? driverLabel[cfg.reception.driver] ?? cfg.reception.driver : '—'} />
        <InfoRow
          label="Estado"
          value={
            <span className={`status-pill ${status?.zmq_connected ? 'on' : 'off'}`}>
              {status?.zmq_connected ? 'ACTIVO' : 'INACTIVO'}
            </span>
          }
        />
        {restartMsg && (
          <p className="empty-note" style={{ fontSize: 10, marginTop: 6, marginBottom: 0 }}>
            {restartMsg}
          </p>
        )}
        <p className="empty-note" style={{ fontSize: 9.5, marginTop: 6, marginBottom: 0 }}>
          Úsalo si desconectaste/reconectaste el dispositivo — el backend C no se recupera solo de eso.
        </p>
      </div>

      <div className="pyqt-panel">
        <div className="panel-title">Parámetros RF</div>
        <InfoRow label="Frecuencia central" value={cfg ? `${cfg.reception.frequency_mhz.toFixed(3)} MHz` : '—'} />
        <InfoRow label="Ganancia RF" value={cfg ? `${cfg.reception.gain_db.toFixed(0)} dB` : '—'} />
      </div>

      <div className="pyqt-panel">
        <div className="panel-title">Demodulación</div>
        <InfoRow label="Modulación" value={cfg?.reception.modulation ?? '—'} />
        <InfoRow label="Bandwidth" value={`${FIXED_DEMOD.bandwidth_hz} Hz`} />
        <InfoRow label="Symbol rate" value={`${FIXED_DEMOD.symbol_rate_sps} sps`} />
        <InfoRow label="Freq. dev." value={`${FIXED_DEMOD.freq_dev_hz} Hz`} />
        <InfoRow label="Sync word" value={cfg?.reception.sync_word ?? '—'} />
      </div>

      <div className="pyqt-panel">
        <div className="panel-title">Power gate</div>
        <InfoRow label="Threshold" value="0.0 (deshabilitado)" />
      </div>

      <div className="pyqt-panel">
        <div className="panel-title">Waterfall</div>
        <p className="empty-note" style={{ fontSize: 10, marginBottom: 6 }}>
          Solo cambia la escala de color del dibujo — no toca el hardware ni lo que se captura.
        </p>
        <div className="field-row">
          <span className="fl">Min level</span>
          <span className="fv-edit">
            <input
              type="number"
              className="fv-input"
              value={dbMin}
              max={dbMax - 1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) onChange({ dbMin: v, dbMax })
              }}
            />
            dB
          </span>
        </div>
        <div className="field-row">
          <span className="fl">Max level</span>
          <span className="fv-edit">
            <input
              type="number"
              className="fv-input"
              value={dbMax}
              min={dbMin + 1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) onChange({ dbMin, dbMax: v })
              }}
            />
            dB
          </span>
        </div>
      </div>

      <div className="pyqt-panel">
        <div className="panel-title">Telem dump</div>
        <p className="empty-note" style={{ fontSize: 10.5 }}>
          Carpeta configurada en <code>headless_receiver.yaml</code> (<code>images_dir</code>).
        </p>
      </div>
    </div>
  )
}

function DecodedPacketsConsole() {
  const { logs, messages } = useTelemetry()

  const items = useMemo(() => {
    const sdrMsgs = messages
      .filter((m) => m.source === 'sdr')
      .map((m) => ({
        ts: m.ts,
        text: `${m.pkt_type_name || `type ${m.pkt_type}`} · ${m.decoded ? 'decodificado' : `error: ${m.error || '?'}`} · ${m.size_bytes}B`,
      }))
    const allLogs = logs.map((l) => ({ ts: l.ts, text: l.text }))
    return [...sdrMsgs, ...allLogs].sort((a, b) => b.ts - a.ts).slice(0, 150)
  }, [logs, messages])

  return (
    <div className="cmd-console-panel sdr-diag-console">
      <div className="pyqt-panel-title">
        <span className="console-dots">
          <span />
          <span />
          <span />
        </span>
        DECODED PACKETS
      </div>
      <div className="cmd-console-terminal">
        {items.length === 0 ? (
          <p className="empty-note">Waiting for SDR data…</p>
        ) : (
          items.map((it, i) => (
            <div key={i}>
              [{new Date(it.ts * 1000).toLocaleTimeString()}] {it.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function SdrDiagnostico() {
  const [range, setRange] = useState({ dbMin: -120, dbMax: 0 })

  return (
    <div className="page">
      <h2>Diagnóstico SDR</h2>
      <div className="sdr-diag-grid">
        <DeviceSettingsColumn dbMin={range.dbMin} dbMax={range.dbMax} onChange={setRange} />
        <SpectrumScope theme="light" title="RF Spectrum" dbMin={range.dbMin} dbMax={range.dbMax} />
        <DecodedPacketsConsole />
      </div>
    </div>
  )
}
