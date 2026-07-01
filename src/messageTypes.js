// ======================================================
// /chat/send Message-Type-Allowlist (Migration M0.5)
// ======================================================
// Heute gated `/chat/send` den `type` NICHT gegen eine Allowlist → beliebige
// Clients können beliebige Types injizieren. Das ist die Voraussetzung, um
// später sicher neue Control-Types (pq_rekey/pq_kem_ct/skdm/skdm_request aus
// P3/P4) einzuführen und Fremdinjektion zu unterbinden.
//
// Reguläre Chat-Nachricht = KEIN type (undefined/null/'').
// DARK-LAUNCH: chatSend loggt unbekannte Types nur; Enforcement (Reject) erst
// via env.TYPE_ALLOWLIST_ENFORCE, nachdem die Logs zeigen dass kein legitimer
// Traffic unbekannte Types nutzt.
//
// Pure Funktion → Node-Unit-Test (tests/messageTypes.test.js).
// ======================================================

// Autoritativ aus src/helpers/chatSend.js (die Types, auf die der Server verzweigt).
export const CONTROL_TYPES = new Set([
  'pulse',
  'cmk', 'cmk_req', 'cmk_unavailable', 'cmk_rotate', 'cmk_reset',
  'epoch_rotate', 'auto_delete_set',
  'gsk', 'request_gsk',
]);

// Für die Signal/PQ-Migration RESERVIERT (P3/P4) — noch KEIN Server-Handler,
// nur forward-declared, damit neue Clients keine unknown_type-Logs erzeugen,
// sobald sie diese Types senden. Handler kommen mit der jeweiligen Phase.
export const RESERVED_TYPES = new Set([
  'pq_rekey', 'pq_kem_ct',   // P3.2 Triple-Ratchet
  'skdm', 'skdm_request',    // P4 Group-Sender-Key-Distribution
]);

/**
 * True für: reguläre Nachricht (kein type) ODER bekannter Control-/Reserved-Type.
 * @param {*} type - body.type
 * @returns {boolean}
 */
export function isKnownMessageType(type) {
  if (type === undefined || type === null || type === '') return true; // reguläre Nachricht
  if (typeof type !== 'string') return false;
  return CONTROL_TYPES.has(type) || RESERVED_TYPES.has(type);
}
