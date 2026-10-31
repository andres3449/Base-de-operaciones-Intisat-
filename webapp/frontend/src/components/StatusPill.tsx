import type { ReactNode } from 'react'

interface Props {
  state: 'on' | 'off' | 'warn'
  children: ReactNode
}

/** Pure presentational pill — the caller decides `state` from real data
 * (e.g. useTelemetry().wsConnected, status?.zmq_connected, ValueTile's own
 * staleness). Never derives a state on its own from a threshold that isn't
 * backed by a real channel. */
export function StatusPill({ state, children }: Props) {
  return <span className={`status-pill ${state}`}>{children}</span>
}
