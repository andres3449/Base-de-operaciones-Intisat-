import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, wsURL, type MessageEntry, type StatusResponse } from '../api'

export interface ChannelReading {
  value: number
  ts: number
}

export interface LogEntry {
  ts: number
  text: string
}

interface TelemetryFrame {
  kind: 'telemetry'
  ts: number
  source: string
  satellite_id?: string
  channels: Record<string, number>
}

interface MessageFrame extends MessageEntry {
  kind: 'message'
}

interface LogFrame {
  kind: 'log'
  ts: number
  text: string
}

type WsFrame = TelemetryFrame | MessageFrame | LogFrame

const BUFFER_LIMIT = 300

interface TelemetryState {
  live: Record<string, ChannelReading>
  wsConnected: boolean
  status: StatusResponse | null
  ready: boolean
  logs: LogEntry[]
  messages: MessageEntry[]
}

const TelemetryCtx = createContext<TelemetryState>({
  live: {},
  wsConnected: false,
  status: null,
  ready: false,
  logs: [],
  messages: [],
})

export function useTelemetry() {
  return useContext(TelemetryCtx)
}

export function useChannel(name: string): ChannelReading | undefined {
  return useTelemetry().live[name]
}

const RECONNECT_DELAY_MS = 2000

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Record<string, ChannelReading>>({})
  const [wsConnected, setWsConnected] = useState(false)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [ready, setReady] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const liveRef = useRef(live)
  liveRef.current = live

  // Seed initial values from REST so tiles aren't empty before the first WS
  // frame, and mark the app "ready" once this first fetch settles (success
  // or failure — a backend that's down shouldn't leave the splash forever).
  useEffect(() => {
    api
      .latest()
      .then(({ values }) => {
        const seeded: Record<string, ChannelReading> = {}
        for (const v of values) seeded[v.channel] = { value: v.value, ts: v.ts }
        setLive((prev) => ({ ...seeded, ...prev }))
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  // Poll backend/bridge status every 5s (frame counters, ZMQ connection).
  useEffect(() => {
    const tick = () => api.status().then(setStatus).catch(() => setStatus(null))
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  // Persistent WebSocket with auto-reconnect. Every event is tagged with a
  // `kind` discriminator by the backend (webapp/backend/zmq_ingest.py) so a
  // single socket can feed telemetry tiles/charts, the live log panel and
  // the messages table without opening separate connections.
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      ws = new WebSocket(wsURL())
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => {
        setWsConnected(false)
        if (!cancelled) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
      ws.onerror = () => ws?.close()
      ws.onmessage = (ev) => {
        try {
          const frame: WsFrame = JSON.parse(ev.data)
          if (frame.kind === 'telemetry') {
            setLive((prev) => {
              const next = { ...prev }
              for (const [ch, val] of Object.entries(frame.channels)) {
                next[ch] = { value: val, ts: frame.ts }
              }
              return next
            })
          } else if (frame.kind === 'message') {
            const { kind: _kind, ...entry } = frame
            setMessages((prev) => [entry, ...prev].slice(0, BUFFER_LIMIT))
          } else if (frame.kind === 'log') {
            setLogs((prev) => [{ ts: frame.ts, text: frame.text }, ...prev].slice(0, BUFFER_LIMIT))
          }
        } catch {
          // ignore malformed frame
        }
      }
    }
    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  return (
    <TelemetryCtx.Provider value={{ live, wsConnected, status, ready, logs, messages }}>
      {children}
    </TelemetryCtx.Provider>
  )
}
