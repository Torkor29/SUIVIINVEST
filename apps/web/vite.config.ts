import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Configuration Vite du frontend SuiviInvest.
 * Le serveur de développement écoute sur 5177 et relaie /api vers l'API locale.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  preview: { port: 5177, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
