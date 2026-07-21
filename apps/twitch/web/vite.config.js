import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { eventsPlugin } from './vite-events-plugin.js';

const PORT = Number(process.env.OVERLAY_PORT) || 5183;

export default defineConfig({
  plugins: [react(), eventsPlugin()],
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
  build: { outDir: 'dist' },
});
