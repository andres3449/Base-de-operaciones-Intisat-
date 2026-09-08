import { useEffect, useState } from 'react'
import { api, type ImageInfo } from '../api'

export function Payload() {
  const [images, setImages] = useState<ImageInfo[]>([])

  useEffect(() => {
    const refresh = () => api.images().then((r) => setImages(r.images)).catch(() => {})
    refresh()
    const id = setInterval(refresh, 10000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="page">
      <h2>Payload</h2>

      <div className="panel">
        <div className="panel-title">Imágenes recibidas ({images.length})</div>
        {images.length === 0 ? (
          <p className="empty-note">
            Todavía no llegó ninguna imagen. Se guardan automáticamente cuando el receptor headless
            arma una foto completa (comando PHOTO/BURST, en vivo o programado desde Configuración).
          </p>
        ) : (
          <div className="image-grid">
            {images.map((img) => (
              <a key={img.filename} href={api.imageURL(img.filename)} target="_blank" rel="noreferrer" className="image-card">
                <img src={api.imageURL(img.filename)} alt={img.filename} loading="lazy" />
                <div className="image-card-meta">
                  <span>{new Date(img.modified * 1000).toLocaleString()}</span>
                  <span>{(img.size_bytes / 1024).toFixed(1)} KB</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
