import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTelemetry } from '../telemetry/TelemetryContext'
import { NAV_SECTIONS } from '../nav'

const COLLAPSE_KEY = 'intisat-sidebar-collapsed'

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function Sidebar() {
  const { pathname } = useLocation()
  const { wsConnected, status } = useTelemetry()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed))
    } catch {
      // browser storage unavailable — collapse state just won't persist
    }
  }, [collapsed])

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="brand">
        <img className="brand-logo" src="/intisat_logo.png" alt="INTISAT mission patch" width={38} height={38} />
        {!collapsed && (
          <div className="brand-text">
            <strong>INTISAT</strong>
            <span>MISSION CONTROL</span>
          </div>
        )}
      </div>

      <nav>
        {NAV_SECTIONS.map((s) => (
          <NavLink key={s.id} to={s.path} title={s.label} className={pathname.startsWith(`/${s.id}/`) ? 'active' : ''}>
            <Icon d={s.icon} />
            {!collapsed && <span>{s.label}</span>}
          </NavLink>
        ))}
      </nav>

      <button type="button" className="sidebar-collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed} title={collapsed ? 'Expand' : 'Collapse'}>
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d={collapsed ? 'm8 5 6 5-6 5' : 'm12 5-6 5 6 5'} />
        </svg>
      </button>

      <div className="sidebar-status">
        <div className="status-row">
          <span className={`status-dot ${wsConnected ? 'ok' : 'bad'}`} />
          {!collapsed && (wsConnected ? 'Web connected' : 'Disconnected')}
        </div>
        {!collapsed && (
          <>
            <div className="status-row">
              <span className={`status-dot ${status?.zmq_connected ? 'ok' : 'bad'}`} />
              Telemetry bridge {status?.zmq_connected ? 'connected' : 'unavailable'}
            </div>
            <div className="status-row">Received frames: {status?.frames_received ?? '—'}</div>
          </>
        )}
      </div>
    </aside>
  )
}
