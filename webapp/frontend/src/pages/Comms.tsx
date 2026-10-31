import { useEffect, useMemo, useState } from 'react'
import { api, type SatelliteConfig } from '../api'
import { useChannel, useTelemetry } from '../telemetry/TelemetryContext'
import { SpectrumScope } from '../components/SpectrumScope'

const FIXED_DEMOD = { bandwidth_hz: 30000, symbol_rate_sps: 9600, freq_dev_hz: 5000 }

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mc-field">
      <span>{label}</span>
      <span className="mc-fv">{value}</span>
    </div>
  )
}

function Inline({ channel, unit = '', decimals = 1 }: { channel: string; unit?: string; decimals?: number }) {
  const reading = useChannel(channel)
  return <>{reading ? `${reading.value.toFixed(decimals)}${unit}` : '—'}</>
}

function LinkBar() {
  return (
    <div className="mc-linkbar">
      <b>LINK METRICS</b>
      <span>RSSI: <Inline channel="sim.coms_rssi" unit=" dBm" /></span>
      <span>SNR: <Inline channel="sim.coms_snr" unit=" dB" /></span>
      <span>Downlink: <Inline channel="sim.coms_downlink_rate" unit=" bps" decimals={0} /></span>
      <span>BER: <Inline channel="sim.coms_ber" decimals={4} /></span>
    </div>
  )
}

function ControlsColumn({ range, onRange }: { range: { dbMin: number; dbMax: number }; onRange: (r: { dbMin: number; dbMax: number }) => void }) {
  const { status } = useTelemetry()
  const [cfg, setCfg] = useState<SatelliteConfig | null>(null)

  useEffect(() => {
    const refresh = () => api.getSatellite().then(setCfg).catch(() => {})
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [])

  const driverLabel: Record<string, string> = { mcu: 'MCU (UART)', limesdr: 'LimeSDR', rtlsdr: 'RTL-SDR' }

  return (
    <div className="mc-controls">
      <section className="card">
        <h2>DEVICE</h2>
        <div className="mc-field"><span>Driver</span><span className={`mc-state ${status?.zmq_connected ? 'live' : ''}`}>{cfg ? driverLabel[cfg.reception.driver] ?? cfg.reception.driver : '—'}</span></div>
        <div className="mc-field"><span>Estado</span><span className={`mc-state ${status?.zmq_connected ? 'live' : ''}`}>{status?.zmq_connected ? 'ACTIVO' : 'INACTIVO'}</span></div>
      </section>

      <section className="card">
        <h2>RF SETTINGS</h2>
        <Field label="Center (MHz)" value={cfg ? cfg.reception.frequency_mhz.toFixed(3) : '—'} />
        <Field label="RF gain" value={cfg ? `${cfg.reception.gain_db.toFixed(0)} dB` : '—'} />
        <div className="mc-tiny">Configurable en Configuración → SDR y Recepción.</div>
      </section>

      <section className="card">
        <h2>DEMODULATION</h2>
        <Field label="Modulación" value={cfg?.reception.modulation ?? '—'} />
        <Field label="Bandwidth" value={`${FIXED_DEMOD.bandwidth_hz} Hz`} />
        <Field label="Symbol rate" value={`${FIXED_DEMOD.symbol_rate_sps} sps`} />
        <Field label="Freq. dev." value={`${FIXED_DEMOD.freq_dev_hz} Hz`} />
        <Field label="Sync word" value={cfg?.reception.sync_word ?? '—'} />
      </section>

      <section className="card">
        <h2>POWER GATE</h2>
        <Field label="Threshold" value="0.0 (deshabilitado)" />
        <div className="mc-tiny">Suprime paquetes débiles. 0 = desactivado.</div>
      </section>

      <section className="card">
        <h2>UPLINK TX</h2>
        <div className="mc-tiny">Inactivo · sin transmisión en curso</div>
      </section>

      <section className="card">
        <h2>WATERFALL LEVELS</h2>
        <div className="mc-field">
          <span>Min level</span>
          <input
            type="range" min={-140} max={-60} value={range.dbMin}
            onChange={(e) => onRange({ dbMin: Number(e.target.value), dbMax: range.dbMax })}
          />
          <span className="mc-fv">{range.dbMin} dB</span>
        </div>
        <div className="mc-field">
          <span>Max level</span>
          <input
            type="range" min={-59} max={0} value={range.dbMax}
            onChange={(e) => onRange({ dbMin: range.dbMin, dbMax: Number(e.target.value) })}
          />
          <span className="mc-fv">{range.dbMax} dB</span>
        </div>
      </section>
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
        kind: m.decoded ? 'ok' : 'warn',
        text: `${m.pkt_type_name || `type ${m.pkt_type}`} · ${m.decoded ? 'decodificado' : `error: ${m.error || '?'}`} · ${m.size_bytes}B`,
      }))
    const allLogs = logs.map((l) => ({ ts: l.ts, kind: '', text: l.text }))
    return [...sdrMsgs, ...allLogs].sort((a, b) => b.ts - a.ts).slice(0, 150)
  }, [logs, messages])

  const total = messages.filter((m) => m.source === 'sdr').length
  const valid = messages.filter((m) => m.source === 'sdr' && m.decoded).length

  return (
    <section className="card mc-console">
      <div className="mc-console-head">
        <h2>DECODED PACKETS</h2>
      </div>
      <div className="mc-counterrow">
        <span>Total: <b>{total}</b></span>
        <span>Valid: <b>{valid}</b></span>
        <span>Rejected: <b>{total - valid}</b></span>
      </div>
      <div className="mc-log">
        {items.length === 0 ? (
          <div>Esperando paquetes SDR…</div>
        ) : (
          items.map((it, i) => (
            <div key={i} className={it.kind}>
              [{new Date(it.ts * 1000).toLocaleTimeString()}] {it.text}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

export function Comms() {
  const [range, setRange] = useState({ dbMin: -120, dbMax: 0 })

  return (
    <div className="page mc-comms">
      <LinkBar />
      <div className="mc-workspace">
        <ControlsColumn range={range} onRange={setRange} />
        <div className="mc-plots">
          <SpectrumScope theme="light" title="RF SPECTRUM" dbMin={range.dbMin} dbMax={range.dbMax} />
        </div>
        <DecodedPacketsConsole />
      </div>
    </div>
  )
}
