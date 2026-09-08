import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useHistory } from '../telemetry/useHistory'

interface Props {
  title: string
  channel: string
  color?: string
  unit?: string
  minutes?: number
}

function ChartTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean
  payload?: { value: number }[]
  label?: number
  unit: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <div className="t">{new Date(label ?? 0).toLocaleTimeString()}</div>
      <div className="v">
        {payload[0].value}
        {unit}
      </div>
    </div>
  )
}

export function HistoryChart({ title, channel, color = '#22D3EE', unit = '', minutes = 30 }: Props) {
  const points = useHistory(channel, minutes)
  const data = points.map((p) => ({ t: p.ts * 1000, v: p.value }))
  const gradId = `grad-${channel.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <div className="chart-card">
      <div className="panel-title">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(148,163,184,0.1)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => new Date(t).toLocaleTimeString()}
            stroke="rgba(148,163,184,0.25)"
            tick={{ fill: '#64748B', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            stroke="rgba(148,163,184,0.25)"
            tick={{ fill: '#64748B', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            unit={unit}
            domain={['auto', 'auto']}
            width={54}
          />
          <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: 'rgba(148,163,184,0.3)', strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2.25}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
