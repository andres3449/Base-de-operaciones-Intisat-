import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { sectionForPath } from '../nav'
import { DataState } from './MissionTelemetry'

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatUTC(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

export function Topbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { authenticated, logout } = useAuth()
  const now = useClock()
  const section = sectionForPath(location.pathname)

  async function handleAuthClick() {
    if (authenticated) {
      await logout()
      navigate('/dashboard/general')
    } else {
      navigate('/login')
    }
  }

  return (
    <div className="topbar">
      <div className="topbar-row">
        <div className="topbar-title">{section?.label ?? 'INTISAT'}</div>
        <div className="topbar-spacer" />
        <span className="topbar-clock mono">{formatUTC(now)}</span>
        <button type="button" className="topbar-admin-btn" onClick={handleAuthClick}>
          {authenticated ? 'Sign out' : 'Admin sign in'}
        </button>
      </div>
      {section && section.tabs.length > 1 && (
        <nav className="section-tabs">
          {section.tabs.map((t) => (
            <NavLink key={t.path} to={t.path} className={({ isActive }) => (isActive ? 'active' : '')}>
              {t.label}
            </NavLink>
          ))}
          <div className="section-status"><DataState /></div>
        </nav>
      )}
    </div>
  )
}
