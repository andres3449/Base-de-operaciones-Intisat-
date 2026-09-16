import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useTelemetry } from '../telemetry/TelemetryContext'

const icon = (d: string): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const MAIN_LINKS = [
  { to: '/', label: 'Dashboard', icon: icon('M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6ZM13 9h8V3h-8v6Z') },
  { to: '/eps-thermal', label: 'EPS / Thermal', icon: icon('M13 2 3 14h7l-1 8 10-12h-7l1-8Z') },
  { to: '/adcs', label: 'ADCS', icon: icon('M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z') },
  { to: '/comms', label: 'Comms', icon: icon('M4 12a8 8 0 0 1 16 0M7 12a5 5 0 0 1 10 0M12 12v9M12 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z') },
  { to: '/payload', label: 'Payload', icon: icon('M4 8h3l2-2h6l2 2h3v11H4V8Zm8 8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z') },
  { to: '/orbita', label: 'Órbita', icon: icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9m0-18c-2.5 2.5-3.8 5.6-3.8 9s1.3 6.5 3.8 9M3.5 9h17M3.5 15h17') },
  { to: '/logs', label: 'Logs', icon: icon('M4 4h16v4H4V4Zm0 6h16v10H4V10Zm3 3h6M7 16h10') },
]

const OPS_LINKS = [
  { to: '/config', label: 'Configuración', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.15-1.55l2.1-1.63-2-3.46-2.48 1a8 8 0 0 0-2.68-1.55L14.4 2h-4.8l-.4 2.81a8 8 0 0 0-2.68 1.55l-2.48-1-2 3.46 2.1 1.63a8 8 0 0 0 0 3.1L1.94 15.18l2 3.46 2.48-1a8 8 0 0 0 2.68 1.55l.4 2.81h4.8l.4-2.81a8 8 0 0 0 2.68-1.55l2.48 1 2-3.46-2.1-1.63A8 8 0 0 0 20 12Z') },
  { to: '/programacion', label: 'Programación', icon: icon('M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z') },
]

function NavItem({ to, label, icon, end }: { to: string; label: string; icon: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      {icon}
      {label}
    </NavLink>
  )
}

export function Sidebar() {
  const { wsConnected, status } = useTelemetry()

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">IS</div>
        <div className="brand-text">
          <strong>INTISAT</strong>
          <span>Sala de Monitoreo</span>
        </div>
      </div>

      <nav>
        {MAIN_LINKS.map((l) => (
          <NavItem key={l.to} to={l.to} label={l.label} icon={l.icon} end={l.to === '/'} />
        ))}
      </nav>

      <div className="sidebar-group-label">Centro de Operaciones</div>
      <div className="sidebar-group-frame">
        {OPS_LINKS.map((l) => (
          <NavItem key={l.to} to={l.to} label={l.label} icon={l.icon} />
        ))}
      </div>

      <div className="sidebar-status">
        <div className="status-row">
          <span className={`status-dot ${wsConnected ? 'ok' : 'bad'}`} />
          {wsConnected ? 'Conectado' : 'Desconectado'}
        </div>
        <div className="status-row">
          <span className={`status-dot ${status?.zmq_connected ? 'ok' : 'bad'}`} />
          Puente PyQt {status?.zmq_connected ? 'activo' : 'inactivo'}
        </div>
        <div className="status-row">Frames recibidos: {status?.frames_received ?? 0}</div>
      </div>
    </aside>
  )
}
