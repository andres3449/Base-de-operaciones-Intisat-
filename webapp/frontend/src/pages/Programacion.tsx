import { useEffect, useMemo, useState } from 'react'
import { api, type OnceSchedule, type RecurringSchedule } from '../api'
import { TransmitWarning, useSatelliteDriver } from '../components/TransmitWarning'

const HOUR_HEIGHT = 44
const DAY_MS = 86400000
const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

function startOfWeek(d: Date): Date {
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

function fmtRange(a: Date, b: Date): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  return `${a.toLocaleDateString(undefined, opts)} – ${b.toLocaleDateString(undefined, opts)} ${b.getFullYear()}`
}

interface RecurringBlock {
  entry: RecurringSchedule
  dayIndex: number
  topPct: number
  heightPct: number
}

interface OnceMarker {
  entry: OnceSchedule
  dayIndex: number
  topPct: number
}

export function Programacion() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [recurring, setRecurring] = useState<RecurringSchedule[]>([])
  const [once, setOnce] = useState<OnceSchedule[]>([])
  const driver = useSatelliteDriver()

  useEffect(() => {
    const refresh = () => api.schedule().then((s) => {
      setRecurring(s.recurring)
      setOnce(s.once)
    }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [])

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  )

  const recurringBlocks = useMemo<RecurringBlock[]>(() => {
    const blocks: RecurringBlock[] = []
    for (const entry of recurring) {
      const start = new Date(entry.window_start)
      const end = new Date(entry.window_end)
      days.forEach((day, dayIndex) => {
        const dayStart = day.getTime()
        const dayEnd = dayStart + DAY_MS
        const ovStart = Math.max(start.getTime(), dayStart)
        const ovEnd = Math.min(end.getTime(), dayEnd)
        if (ovEnd <= ovStart) return
        blocks.push({
          entry,
          dayIndex,
          topPct: ((ovStart - dayStart) / DAY_MS) * 100,
          heightPct: ((ovEnd - ovStart) / DAY_MS) * 100,
        })
      })
    }
    return blocks
  }, [recurring, days])

  const onceMarkers = useMemo<OnceMarker[]>(() => {
    const markers: OnceMarker[] = []
    for (const entry of once) {
      const at = new Date(entry.fire_at)
      const dayIndex = days.findIndex((d) => at >= d && at.getTime() < d.getTime() + DAY_MS)
      if (dayIndex === -1) continue
      const dayStart = days[dayIndex].getTime()
      markers.push({ entry, dayIndex, topPct: ((at.getTime() - dayStart) / DAY_MS) * 100 })
    }
    return markers
  }, [once, days])

  const today = new Date()
  const todayIndex = days.findIndex(
    (d) => d.toDateString() === today.toDateString(),
  )

  return (
    <div className="page">
      <h2>Programación</h2>

      <TransmitWarning schedule={{ recurring, once }} driver={driver} />

      <div className="cal-toolbar">
        <button type="button" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}>
          ← Semana anterior
        </button>
        <div className="cal-range">{fmtRange(days[0], days[6])}</div>
        <button type="button" onClick={() => setWeekStart(startOfWeek(new Date()))}>
          Hoy
        </button>
        <button type="button" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}>
          Semana siguiente →
        </button>
      </div>

      <div className="cal-grid-wrap">
        <div className="cal-grid" style={{ gridTemplateRows: `auto repeat(24, ${HOUR_HEIGHT}px)` }}>
          <div className="cal-corner" />
          {days.map((d, i) => (
            <div key={i} className={`cal-day-head${i === todayIndex ? ' today' : ''}`}>
              <span className="cal-day-name">{DAY_LABELS[i]}</span>
              <span className="cal-day-num">{d.getDate()}</span>
            </div>
          ))}

          {Array.from({ length: 24 }, (_, h) => (
            <div key={`hl-${h}`} className="cal-hour-label" style={{ gridRow: h + 2 }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
          {days.map((_, dayIndex) =>
            Array.from({ length: 24 }, (_, h) => (
              <div
                key={`cell-${dayIndex}-${h}`}
                className="cal-cell"
                style={{ gridRow: h + 2, gridColumn: dayIndex + 2 }}
              />
            )),
          )}

          {recurringBlocks.map((b, i) => (
            <div
              key={`rec-${i}`}
              className="cal-block"
              style={{
                gridRow: '2 / span 24',
                gridColumn: b.dayIndex + 2,
                top: `${b.topPct}%`,
                height: `${b.heightPct}%`,
              }}
              title={`${b.entry.command} · cada ${b.entry.interval_s}s`}
            >
              <strong>{b.entry.command}</strong>
              <span>cada {b.entry.interval_s}s</span>
            </div>
          ))}

          {onceMarkers.map((m, i) => (
            <div
              key={`once-${i}`}
              className={`cal-marker${m.entry.fired ? ' fired' : ''}`}
              style={{ gridRow: '2 / span 24', gridColumn: m.dayIndex + 2, top: `${m.topPct}%` }}
              title={`${m.entry.command} · ${new Date(m.entry.fire_at).toLocaleTimeString()}`}
            >
              ● {m.entry.command}
            </div>
          ))}
        </div>
      </div>

      {recurring.length === 0 && once.length === 0 && (
        <p className="empty-note" style={{ marginTop: 16 }}>
          Nada programado todavía — se arma desde la página de Configuración.
        </p>
      )}
    </div>
  )
}
