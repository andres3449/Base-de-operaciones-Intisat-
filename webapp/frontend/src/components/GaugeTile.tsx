import { useChannel } from '../telemetry/TelemetryContext'

interface Props {
  label: string
  channel: string
  max?: number
  unit?: string
  decimals?: number
}

export function GaugeTile({ label, channel, max = 100, unit = '%', decimals = 0 }: Props) {
  const reading = useChannel(channel)
  const value = reading?.value ?? 0
  const pct = Math.max(0, Math.min(100, (value / max) * 100))

  return (
    <div className="gauge-row">
      <div className="gl">
        <span>{label}</span>
        <b>{reading ? `${value.toFixed(decimals)}${unit}` : '—'}</b>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
