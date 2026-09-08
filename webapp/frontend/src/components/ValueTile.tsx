import { useEffect, useRef, useState } from 'react'
import { useChannel } from '../telemetry/TelemetryContext'

interface Props {
  label: string
  channel: string
  unit?: string
  decimals?: number
  staleAfterS?: number
}

export function ValueTile({ label, channel, unit = '', decimals = 2, staleAfterS = 15 }: Props) {
  const reading = useChannel(channel)
  const ageS = reading ? Date.now() / 1000 - reading.ts : Infinity
  const stale = ageS > staleAfterS

  // Remounting the value span (via a bumped key) restarts the flash
  // keyframes cleanly each time a fresh reading comes in for this channel.
  const [flashTick, setFlashTick] = useState(0)
  const lastTs = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (reading && reading.ts !== lastTs.current) {
      if (lastTs.current !== undefined) setFlashTick((n) => n + 1)
      lastTs.current = reading.ts
    }
  }, [reading])

  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div key={flashTick} className={`tile-value${stale ? ' stale' : ''}${flashTick ? ' flash' : ''}`}>
        {reading ? `${reading.value.toFixed(decimals)}${unit}` : '—'}
      </div>
    </div>
  )
}
