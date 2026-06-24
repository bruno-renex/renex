// ======================================================
// Proof-of-Work (L1) — Client-Wrapper + Send-Helper
// ======================================================
// proveWork(): rechnet die Nonce (im Worker, Fallback inline) für eine
// Nachricht. sendChatWithPow(): hängt die Nonce an den Body, sendet via
// /chat/send und macht bei `429 pow_weak` genau EINEN Reject-Retry mit der
// vom Server geforderten Schwierigkeit (E1 — optimistisch + Reject-Retry).
//
// Default-Bits müssen mit dem Server-Floor (env.POW_MIN_BITS, src/powCheck.js
// POW_FLOOR_BITS=17) zusammenpassen; bei Drift korrigiert der Reject-Retry.
// ======================================================
import { solvePow } from './powCore.js';
import { apiFetch } from './api.js';

export const POW_DEFAULT_BITS = 17;

let _workerSupported = typeof Worker !== 'undefined';

// Findet eine Nonce mit >= bits führenden Null-Bits. Bevorzugt Web Worker
// (UI bleibt flüssig); fällt auf inline-Berechnung zurück (Tests/SSR/kein
// Worker/Timeout). Gibt null zurück, wenn nichts gefunden wurde.
export async function proveWork({ sid, epoch, sig, ctB64, bits = POW_DEFAULT_BITS }, timeoutMs = 10_000) {
  if (_workerSupported) {
    try {
      const nonce = await new Promise((resolve) => {
        const w = new Worker(new URL('./pow.worker.js', import.meta.url), { type: 'module' });
        const done = (val) => {
          clearTimeout(t);
          try { w.terminate(); } catch {}
          resolve(val);
        };
        const t = setTimeout(() => done(null), timeoutMs);
        w.addEventListener('message', (e) => done(e.data?.nonce || null));
        w.addEventListener('error', () => done(null));
        w.postMessage({ sid, epoch, sig, ctB64, bits });
      });
      if (nonce) return nonce;
      // Worker-Timeout/-Fehler → einmal inline (kleine bits sind billig).
    } catch {
      _workerSupported = false;
    }
  }
  const r = solvePow({ sid, epoch, sig, ctB64, bits });
  return r ? r.nonce : null;
}

// Sendet eine Chat-Nachricht mit PoW. Mutiert `body` (powNonce/powBits).
// Bei `429 pow_weak{requiredBits}` genau ein Retry mit höherer Schwierigkeit.
export async function sendChatWithPow(body, { sid, epoch, sig, ctB64 } = {}, bits = POW_DEFAULT_BITS) {
  body.powNonce = await proveWork({ sid, epoch, sig, ctB64, bits });
  body.powBits = bits;

  let r = await apiFetch('/chat/send', { method: 'POST', body });

  if (
    r && r.status === 429 && r.data?.error === 'pow_weak' &&
    typeof r.data.requiredBits === 'number' && r.data.requiredBits > bits
  ) {
    body.powNonce = await proveWork({ sid, epoch, sig, ctB64, bits: r.data.requiredBits });
    body.powBits = r.data.requiredBits;
    r = await apiFetch('/chat/send', { method: 'POST', body });
  }

  return r;
}
