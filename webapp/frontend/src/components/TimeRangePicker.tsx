import { useEffect, useState } from 'react'
import type { TimeRange } from '../api'

const PRESETS: { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 h', minutes: 60 },
  { label: '6 h', minutes: 6 * 60 },
  { label: '24 h', minutes: 24 * 60 },
  { label: '7 d', minutes: 7 * 24 * 60 },
]

interface Props {
  /** Fired whenever the effective range changes — pass straight into
   * HistoryChart's `range` prop (or useHistory). Live presets refresh
   * `to_ts` on the given interval so charts keep sliding forward. */
  onChange: (range: TimeRange) => void
  liveRefreshMs?: number
  /** Fewer presets, no custom-range/live-toggle UI — fits inline in a
   * panel title row (e.g. Dashboard's Altitud & Térmica). */
  compact?: boolean
}

export function TimeRangePicker({ onChange, liveRefreshMs = 10000, compact = false }: Props) {
  const [presetMinutes, setPresetMinutes] = useState<number | 'custom'>(60)
  const [live, setLive] = useState(true)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const presets = compact ? PRESETS.filter((p) => [15, 60, 24 * 60].includes(p.minutes)) : PRESETS

  useEffect(() => {
    const compute = () => {
      if (presetMinutes === 'custom') {
        const from_ts = customFrom ? new Date(customFrom).getTime() / 1000 : undefined
        const to_ts = customTo ? new Date(customTo).getTime() / 1000 : undefined
        onChange({ from_ts, to_ts })
        return
      }
      const to_ts = Date.now() / 1000
      onChange({ from_ts: to_ts - presetMinutes * 60, to_ts })
    }
    compute()
    if (presetMinutes === 'custom' || !live) return
    const id = setInterval(compute, liveRefreshMs)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetMinutes, live, customFrom, customTo, liveRefreshMs])

  return (
    <div className={compact ? 'time-range-picker compact' : 'time-range-picker'}>
      {presets.map((p) => (
        <button
          key={p.minutes}
          type="button"
          className={presetMinutes === p.minutes ? 'active' : ''}
          onClick={() => setPresetMinutes(p.minutes)}
        >
          {p.label}
        </button>
      ))}
      {!compact && (
        <button
          type="button"
          className={presetMinutes === 'custom' ? 'active' : ''}
          onClick={() => setPresetMinutes('custom')}
        >
          Rango…
        </button>
      )}

      {!compact && presetMinutes === 'custom' && (
        <div className="time-range-custom">
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            aria-label="Desde"
          />
          <span>→</span>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            aria-label="Hasta"
          />
        </div>
      )}

      {!compact && presetMinutes !== 'custom' && (
        <label className="time-range-live">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          En vivo
        </label>
      )}
    </div>
  )
}
