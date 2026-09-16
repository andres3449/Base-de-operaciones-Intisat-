import { useState } from 'react'
import type React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/config'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await login(username, password)
      navigate(from, { replace: true })
    } catch {
      setError('Usuario o contraseña incorrectos')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page login-page">
      <div className="panel login-panel">
        <div className="panel-title">Centro de Operaciones</div>
        <p className="empty-note">Acceso restringido — Configuración y Programación.</p>
        <form onSubmit={handleSubmit} className="config-form">
          <label>
            Usuario
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label>
            Contraseña
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="config-error">{error}</div>}
          <button type="submit" disabled={saving}>
            {saving ? 'Ingresando…' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  )
}
