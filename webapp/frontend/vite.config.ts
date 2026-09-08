import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev server proxies API/WS calls to the FastAPI backend (native Windows
// process, uvicorn webapp.backend.main:app --port 8000) so the frontend can
// use relative paths in both dev (proxied) and prod (same-origin, FastAPI
// serves the built dist/ directly).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
