import { useEffect, useState } from 'react'
import { api, type CommandRef, type ScheduleResponse } from '../api'

type Mode = 'recurring' | 'once'

function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Config() {
  const [commands, setCommands] = useState<CommandRef[]>([])
  const [schedule, setSchedule] = useState<ScheduleResponse>({ recurring: [], once: [] })
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
    })
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
    <div className="page">
      <h2>Configuración</h2>

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
  )
}
