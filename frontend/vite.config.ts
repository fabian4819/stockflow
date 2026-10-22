import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// /api is proxied to the Go backend in dev, so the browser only ever talks to
// one origin and the backend needs no CORS handling.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:8080',
    },
  },
  test: {
    environment: 'node',
  },
})
