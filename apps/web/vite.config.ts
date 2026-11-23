import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon's address; override with ORSTRA_DAEMON_URL if it runs elsewhere.
const daemon = process.env.ORSTRA_DAEMON_URL ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    // Covers the REST API and the SSE stream at /api/events.
    proxy: { '/api': { target: daemon, changeOrigin: true } },
  },
});
