import { useEffect, useState } from 'react'
import { api, type HistoryPoint } from '../api'

/** Fetches history for one channel and refreshes it on an interval. */
export function useHistory(channel: string, minutes = 30, refreshMs = 10000): HistoryPoint[] {
  const [points, setPoints] = useState<HistoryPoint[]>([])

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      api
        .history(channel, minutes)
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
  }, [channel, minutes, refreshMs])

  return points
}
