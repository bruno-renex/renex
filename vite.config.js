// ======================================================
// Vite Config — Svelte 5 Frontend für RENEX
// ======================================================
// Build-Strategie:
//   - Source: frontend/src/
//   - Output: frontend/dist/
//   - Public assets: frontend/public/ (kopiert direkt)
//
// Während Migration: parallel zur bestehenden /renex/ Vanilla-Codebase.
// Cutover bei Phase 1A.6 Ende: deploy.sh switched zu frontend/dist/.
// ======================================================
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: 'frontend',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,        // Sentry braucht source maps für Stack-Traces
    target: 'es2020',
  },
  server: {
    port: 5173,
    strictPort: false,
    open: false,
  },
  plugins: [
    svelte({
      // Svelte 5 Runes-Mode aktivieren
      compilerOptions: {
        runes: true,
      },
    }),
  ],
});
