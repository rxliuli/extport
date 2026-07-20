import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin cookies in dev: proxy API routes to `wrangler dev`.
      '/auth': 'http://localhost:8787',
      '/v1': 'http://localhost:8787',
      '/healthz': 'http://localhost:8787',
    },
  },
})
