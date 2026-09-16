import { useEffect, useState } from 'react'
import { api, type HistoryPoint, type TimeRange } from '../api'

/** Fetches history for one channel and refreshes it on an interval.
 * `range` is either a fixed `minutes`-from-now window (number, legacy
 * default) or an explicit {from_ts, to_ts} pair from a TimeRangePicker. */
export function useHistory(channel: string, range: TimeRange | number = 30, refreshMs = 10000): HistoryPoint[] {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const key = typeof range === 'number' ? `m:${range}` : `r:${range.from_ts ?? ''}:${range.to_ts ?? ''}`

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      api
        .history(channel, range)
        .then((res) => {
          if (!cancelled) setPoints(res.points)
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, refreshMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, refreshMs])

  return points
}
