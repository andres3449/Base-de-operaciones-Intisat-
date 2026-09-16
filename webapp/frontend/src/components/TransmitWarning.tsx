import { useEffect, useState } from 'react'
import { api, type ScheduleResponse } from '../api'

/** Fetches the active reception driver once and exposes it — both Config
 * and Programación show the same RTL-SDR advisory banner. */
export function useSatelliteDriver(): string | undefined {
  const [driver, setDriver] = useState<string | undefined>(undefined)

  useEffect(() => {
    api
      .getSatellite()
      .then((c) => setDriver(c.reception.driver))
      .catch(() => {})
  }, [])

  return driver
}

export function TransmitWarning({ schedule, driver }: { schedule: ScheduleResponse; driver?: string }) {
  const hasScheduled = schedule.recurring.length > 0 || schedule.once.length > 0
  if (driver !== 'rtlsdr' || !hasScheduled) return null
  return (
    <div className="warning-banner">
      ⚠ El driver activo es RTL-SDR (solo recepción) y hay comandos programados — no se van a
      poder ejecutar porque RTL-SDR no puede transmitir. Cambiá el driver en “Satélite y
      recepción” (Configuración) o quitá los comandos programados.
    </div>
  )
}
