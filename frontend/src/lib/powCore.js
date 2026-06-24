// ======================================================
// Proof-of-Work (L1) — Client-Kern (pure, synchron)
// ======================================================
// Spiegelt die Server-Logik aus src/powCheck.js (powPreimage +
// countLeadingZeroBits) EXAKT. Nutzt synchrones SHA-256 aus @noble/hashes —
// crypto.subtle ist async und für eine PoW-Suchschleife (~10^5..10^6 Hashes)
// viel zu langsam. Läuft im Web Worker (siehe pow.worker.js), damit die Suche
// den UI-Thread nicht blockiert.
//
// EHRLICHER CLAIM: verteuert automatisiertes Massen-Senden. Kein Mensch-Beweis.
// ======================================================
import { sha256 } from '@noble/hashes/sha2.js';

const _enc = new TextEncoder();

// Identisch zu src/powCheck.js#powPreimage.
export function powPreimage({ sid, epoch, sig, ctB64, nonce }) {
  const bind = (typeof sig === 'string' && sig.length) ? sig : (ctB64 || '');
  return `${sid ?? ''}|${epoch ?? 0}|${bind}|${nonce ?? ''}`;
}

// Identisch zu src/powCheck.js#countLeadingZeroBits.
export function countLeadingZeroBits(bytes) {
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

// Sucht synchron eine Nonce mit >= `bits` führenden Null-Bits.
// @returns {{nonce:string, bits:number, iters:number}|null} null bei Erschöpfung.
export function solvePow({ sid, epoch, sig, ctB64, bits }, maxIter = 50_000_000) {
  const prefixBind = (typeof sig === 'string' && sig.length) ? sig : (ctB64 || '');
  const prefix = `${sid ?? ''}|${epoch ?? 0}|${prefixBind}|`;
  for (let n = 0; n < maxIter; n++) {
    const h = sha256(_enc.encode(prefix + n));
    if (countLeadingZeroBits(h) >= bits) {
      return { nonce: String(n), bits, iters: n + 1 };
    }
  }
  return null;
}
