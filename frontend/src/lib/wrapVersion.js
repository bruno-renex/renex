// ======================================================
// Wrap-Algorithmus-Version (Phase 0.2)
// ======================================================
// Additives Versionsfeld für CMK-/GSK-Wraps. Alte Clients ignorieren das Feld;
// neue lesen es TOLERANT (Default = klassisch, wenn absent → Legacy-Wraps bleiben
// gültig). Bereitet 0.3 (Wrap-Signatur deckt algoVersion mit ab → Downgrade-Schutz)
// und die spätere PQ-Migration vor.
//
//   1 = klassisch ECDH-P256 (heute)
//   3 = hybrid X25519/P-256 + ML-KEM-768 (Post-Quanten, später)
// (2 ist absichtlich frei — vermeidet Verwechslung mit der Bundle-Version v=2.)
// ======================================================

export const WRAP_ALGO = Object.freeze({
  ECDH_P256: 1,
  HYBRID_MLKEM768: 3,
});

// Aktuelle Wrap-Version, die neue Clients schreiben.
export const CURRENT_WRAP_ALGO = WRAP_ALGO.ECDH_P256;

/**
 * Liest die Wrap-Algo-Version tolerant aus einem Wrap-Payload.
 * Fehlt das Feld (Legacy-Wrap eines alten Clients), gilt klassisch ECDH-P256.
 * @param {{algoVersion?: number}|null|undefined} wrap
 * @returns {number}
 */
export function wrapAlgoOf(wrap) {
  const v = wrap && wrap.algoVersion;
  return (typeof v === 'number') ? v : WRAP_ALGO.ECDH_P256;
}
