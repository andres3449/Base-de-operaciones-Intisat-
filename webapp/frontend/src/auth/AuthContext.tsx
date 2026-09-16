import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'

interface AuthState {
  authenticated: boolean
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthCtx = createContext<AuthState>({
  authenticated: false,
  loading: true,
  login: async () => {},
  logout: async () => {},
})

export function useAuth() {
  return useContext(AuthCtx)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setAuthenticated(r.authenticated))
      .catch(() => setAuthenticated(false))
      .finally(() => setLoading(false))
  }, [])

  const login = async (username: string, password: string) => {
    await api.login(username, password)
    setAuthenticated(true)
  }

  const logout = async () => {
    await api.logout().catch(() => {})
    setAuthenticated(false)
  }

  return <AuthCtx.Provider value={{ authenticated, loading, login, logout }}>{children}</AuthCtx.Provider>
}
