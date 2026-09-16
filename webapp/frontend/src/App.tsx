import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { SplashScreen } from './components/SplashScreen'
import { RequireAuth } from './components/RequireAuth'
import { AuthProvider } from './auth/AuthContext'
import { TelemetryProvider, useTelemetry } from './telemetry/TelemetryContext'
import { Dashboard } from './pages/Dashboard'
import { EpsThermal } from './pages/EpsThermal'
import { Adcs } from './pages/Adcs'
import { Comms } from './pages/Comms'
import { Payload } from './pages/Payload'
import { Config } from './pages/Config'
import { Programacion } from './pages/Programacion'
import { Orbita } from './pages/Orbita'
import { Logs } from './pages/Logs'
import { Login } from './pages/Login'

const MIN_SPLASH_MS = 900

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <div key={location.pathname} className="page-transition">
      <Routes location={location}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/eps-thermal" element={<EpsThermal />} />
        <Route path="/adcs" element={<Adcs />} />
        <Route path="/comms" element={<Comms />} />
        <Route path="/payload" element={<Payload />} />
        <Route path="/orbita" element={<Orbita />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/config"
          element={
            <RequireAuth>
              <Config />
            </RequireAuth>
          }
        />
        <Route
          path="/programacion"
          element={
            <RequireAuth>
              <Programacion />
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
    ? 'Conectando con la estación'
    : status?.zmq_connected
      ? 'Sincronizando telemetría'
      : 'Esperando puente PyQt'

  return (
    <>
      <SplashScreen visible={showSplash} label={splashLabel} />
      <div className="app-shell">
        <Sidebar />
        <AnimatedRoutes />
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
