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

export const api = {
  status: () => getJSON<StatusResponse>('/api/status'),
  channels: () => getJSON<{ channels: string[] }>('/api/channels'),
  latest: () => getJSON<{ values: LatestValue[] }>('/api/telemetry/latest'),
  history: (channel: string, minutes = 30) =>
    getJSON<{ channel: string; points: HistoryPoint[] }>(
      `/api/telemetry/history?channel=${encodeURIComponent(channel)}&minutes=${minutes}`,
    ),
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
}

export function wsURL(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/live`
}
