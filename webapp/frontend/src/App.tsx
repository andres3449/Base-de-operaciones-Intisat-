import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { SplashScreen } from './components/SplashScreen'
import { RequireAuth } from './components/RequireAuth'
import { AuthProvider } from './auth/AuthContext'
import { TelemetryProvider, useTelemetry } from './telemetry/TelemetryContext'
import { Dashboard } from './pages/Dashboard'
import { EpsThermal } from './pages/EpsThermal'
import { Adcs } from './pages/Adcs'
import { SdrDiagnostico } from './pages/RadioWorkspace'
import { Comms } from './pages/MissionComms'
import { Payload } from './pages/Payload'
import { Config } from './pages/ReceptionSettings'
import { Programacion } from './pages/Scheduling'
import { Orbita } from './pages/Orbita'
import { LogsMensajes, LogsVariables } from './pages/MissionLogs'
import { Login } from './pages/Login'

const MIN_SPLASH_MS = 900

function AnimatedRoutes() {
  const location = useLocation()
  return (
    // Orbit tabs share one key: Orbita runs its own camera transition between views
    <div key={location.pathname.startsWith('/orbita/') ? '/orbita' : location.pathname} className="page-transition">
      <Routes location={location}>
        <Route path="/" element={<Navigate to="/dashboard/general" replace />} />
        <Route path="/dashboard" element={<Navigate to="/dashboard/general" replace />} />
        <Route path="/dashboard/general" element={<Dashboard />} />
        <Route path="/dashboard/eps" element={<EpsThermal />} />
        <Route path="/dashboard/adcs" element={<Adcs />} />
        <Route path="/dashboard/comms" element={<Comms />} />
        <Route path="/dashboard/payload" element={<Payload />} />

        <Route path="/orbita" element={<Navigate to="/orbita/general" replace />} />
        {/* one route so the Orbit page persists across tabs (view-to-view camera handoff) */}
        <Route path="/orbita/:view" element={<Orbita />} />
        <Route path="/orbita/*" element={<Navigate to="/orbita/general" replace />} />
        <Route path="*" element={<Navigate to="/dashboard/general" replace />} />

        <Route path="/logs" element={<Navigate to="/logs/mensajes" replace />} />
        <Route path="/logs/mensajes" element={<LogsMensajes />} />
        <Route path="/logs/variables" element={<LogsVariables />} />

        <Route path="/login" element={<Login />} />

        <Route path="/configuracion" element={<Navigate to="/configuracion/sdr" replace />} />
        <Route
          path="/configuracion/sdr"
          element={
            <RequireAuth>
              <Config />
            </RequireAuth>
          }
        />
        <Route
          path="/configuracion/programacion"
          element={
            <RequireAuth>
              <Programacion />
            </RequireAuth>
          }
        />
        <Route
          path="/configuracion/diagnostico"
          element={
            <RequireAuth>
              <SdrDiagnostico />
            </RequireAuth>
          }
        />
      </Routes>
    </div>
  )
}

function Shell() {
  const { ready, status } = useTelemetry()
  const [minTimeDone, setMinTimeDone] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setMinTimeDone(true), MIN_SPLASH_MS)
    return () => clearTimeout(id)
  }, [])

  const showSplash = !ready || !minTimeDone
  const splashLabel = !ready
    ? 'Connecting to ground station'
    : status?.zmq_connected
      ? 'Synchronizing telemetry'
      : 'Waiting for telemetry bridge'

  return (
    <>
      <SplashScreen visible={showSplash} label={splashLabel} />
      <div className="app-shell">
        <Sidebar />
        <div className="workspace">
          <Topbar />
          <AnimatedRoutes />
        </div>
      </div>
    </>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <TelemetryProvider>
        <HashRouter>
          <Shell />
        </HashRouter>
      </TelemetryProvider>
    </AuthProvider>
  )
}
