import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.CROSSPOINT_SERVER ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true },
    },
  },
});
