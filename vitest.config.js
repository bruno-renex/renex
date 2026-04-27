// ======================================================
// Vitest Configuration für RENEX
// ======================================================
// Tests laufen in Node mit WebCrypto-Polyfill (via globalThis.crypto).
// Unit-Tests für Pure-Functions wie chatCrypto.js — keine DOM-Abhängigkeiten.
// Für DOM-Tests später separates jsdom-Setup.
// ======================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test-Dateien finden
    include: ['tests/**/*.test.js'],
    // Crypto-Tests laufen in Node.js — WebCrypto via globalThis.crypto verfügbar (Node 20+)
    environment: 'node',
    // Timeout pro Test
    testTimeout: 5000,
    // Ausgabe-Format
    reporters: ['verbose'],
  },
});
