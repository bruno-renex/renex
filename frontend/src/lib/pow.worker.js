// ======================================================
// Proof-of-Work (L1) — Web Worker
// ======================================================
// Führt die PoW-Suche off-main-thread aus, damit das Tippen/Senden-UI
// während der ~10^5..10^6 Hashes nicht ruckelt. Reiner Rechen-Worker:
// nimmt {sid,epoch,sig,ctB64,bits}, gibt {nonce} oder {error} zurück.
// ======================================================
import { solvePow } from './powCore.js';

self.onmessage = (e) => {
  const { sid, epoch, sig, ctB64, bits } = e.data || {};
  try {
    const r = solvePow({ sid, epoch, sig, ctB64, bits });
    self.postMessage(r ? { nonce: r.nonce } : { error: 'pow_exhausted' });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
