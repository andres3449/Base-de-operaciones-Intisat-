export interface LatestValue {
  channel: string
  value: number
  ts: number
}

export interface HistoryPoint {
  ts: number
  value: number
}

export interface StatusResponse {
  zmq_connected: boolean
  last_frame_ts: number | null
  seconds_since_last_frame: number | null
  frames_received: number
  backend_uptime_s: number
}

export interface CommandRef {
  name: string
  syntax: string
  description: string
}

export interface RecurringSchedule {
  id: string
  command: string
  window_start: string
  window_end: string
  interval_s: number
  enabled: boolean
  last_fired_at: string | null
}

export interface OnceSchedule {
  id: string
  command: string
  fire_at: string
  enabled: boolean
  fired: boolean
}

export interface ScheduleResponse {
  recurring: RecurringSchedule[]
  once: OnceSchedule[]
}

export interface ImageInfo {
  filename: string
  size_bytes: number
  modified: number
}

export interface AuthStatus {
  authenticated: boolean
}

export interface SatelliteConfig {
  satellite: {
    id: string
    name: string
  }
  reception: {
    driver: 'mcu' | 'limesdr' | 'rtlsdr'
    method: string
    modulation: string
    frequency_mhz: number
    gain_db: number
    sync_word: string
  }
}

export interface MessageEntry {
  ts: number
  satellite_id: string
  source: string
  pkt_type: number
  pkt_type_name: string
  decoded: boolean
  error: string
  size_bytes: number
}

export interface MessageFilters {
  from_ts?: number
  to_ts?: number
  satellite_id?: string
  pkt_type?: number
  source?: string
  decoded?: boolean
  limit?: number
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function sendJSON<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`)
  return res.json()
}

export interface TimeRange {
  from_ts?: number
  to_ts?: number
}

export const api = {
  status: () => getJSON<StatusResponse>('/api/status'),
  channels: () => getJSON<{ channels: string[] }>('/api/channels'),
  latest: () => getJSON<{ values: LatestValue[] }>('/api/telemetry/latest'),
  history: (channel: string, range: TimeRange | number = 30, satelliteId?: string) => {
    const params = new URLSearchParams({ channel })
    if (typeof range === 'number') {
      params.set('minutes', String(range))
    } else {
      if (range.from_ts != null) params.set('from_ts', String(range.from_ts))
      if (range.to_ts != null) params.set('to_ts', String(range.to_ts))
    }
    if (satelliteId) params.set('satellite_id', satelliteId)
    return getJSON<{ channel: string; points: HistoryPoint[] }>(`/api/telemetry/history?${params}`)
  },
  commands: () => getJSON<{ commands: CommandRef[] }>('/api/commands'),
  schedule: () => getJSON<ScheduleResponse>('/api/schedule'),
  addRecurring: (entry: Omit<RecurringSchedule, 'id' | 'last_fired_at'>) =>
    sendJSON<RecurringSchedule>('/api/schedule/recurring', 'POST', entry),
  addOnce: (entry: Omit<OnceSchedule, 'id' | 'fired'>) =>
    sendJSON<OnceSchedule>('/api/schedule/once', 'POST', entry),
  deleteSchedule: (kind: 'recurring' | 'once', id: string) =>
    sendJSON<{ deleted: string }>(`/api/schedule/${kind}/${id}`, 'DELETE'),
  images: () => getJSON<{ images: ImageInfo[] }>('/api/images'),
  imageURL: (filename: string) => `/api/images/${encodeURIComponent(filename)}`,

  login: (username: string, password: string) =>
    sendJSON<{ ok: boolean }>('/api/auth/login', 'POST', { username, password }),
  logout: () => sendJSON<{ ok: boolean }>('/api/auth/logout', 'POST'),
  me: () => getJSON<AuthStatus>('/api/auth/me'),

  getSatellite: () => getJSON<SatelliteConfig>('/api/satellite'),
  putSatellite: (cfg: SatelliteConfig) => sendJSON<SatelliteConfig>('/api/satellite', 'PUT', cfg),
  decoderFileURL: () => '/api/satellite/decoder-file',

  messages: (filters: MessageFilters = {}) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    return getJSON<{ messages: MessageEntry[] }>(`/api/messages?${params}`)
  },
}

export function wsURL(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/live`
}
