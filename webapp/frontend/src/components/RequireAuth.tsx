import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, loading } = useAuth()
  const location = useLocation()

  if (loading) return null
  if (!authenticated) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <>{children}</>
}
