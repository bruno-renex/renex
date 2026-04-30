// ======================================================
// CMK Request State — geteilte Pause-Flags für Decrypt-Pipeline
// ======================================================
// Wird sowohl von chatPipeline.js als auch chat.svelte.js gelesen/geschrieben.
// Eigenes Modul → vermeidet Circular Import.
//
// _pendingCmkReq: Peers für die wir grad auf cmk_response warten.
//   → Decrypt-Retries pausieren bis Antwort/Timeout, kein doppelter cmk_req-Send.
//
// _cmkUnavailable: Peers die explizit cmk_unavailable gesendet haben.
//   → CMK ist beidseitig verloren, nie wieder versuchen, UI patcht zu „unrecoverable".
// ======================================================

const CMK_REQ_TIMEOUT_MS = 30_000;

/** @type {Map<string, {since: number, timeoutId: any}>} */
const _pendingCmkReq = new Map();

/** @type {Set<string>} */
const _cmkUnavailable = new Set();

function _key(h) { return (h || '').toLowerCase(); }

export function isPendingCmkReq(peerHandle) {
  return _pendingCmkReq.has(_key(peerHandle));
}

export function markPendingCmkReq(peerHandle) {
  const k = _key(peerHandle);
  if (!k || _pendingCmkReq.has(k)) return;
  const timeoutId = setTimeout(() => _pendingCmkReq.delete(k), CMK_REQ_TIMEOUT_MS);
  _pendingCmkReq.set(k, { since: Date.now(), timeoutId });
}

export function clearPendingCmkReq(peerHandle) {
  const k = _key(peerHandle);
  const entry = _pendingCmkReq.get(k);
  if (entry) {
    clearTimeout(entry.timeoutId);
    _pendingCmkReq.delete(k);
  }
}

export function isCmkUnavailable(peerHandle) {
  return _cmkUnavailable.has(_key(peerHandle));
}

export function markCmkUnavailable(peerHandle) {
  const k = _key(peerHandle);
  if (k) _cmkUnavailable.add(k);
  // Pending-Flag droppen — auf cmk_req kommt jetzt nichts mehr.
  clearPendingCmkReq(peerHandle);
}

export function clearCmkUnavailable(peerHandle) {
  _cmkUnavailable.delete(_key(peerHandle));
}

export function clearAllCmkState() {
  for (const { timeoutId } of _pendingCmkReq.values()) clearTimeout(timeoutId);
  _pendingCmkReq.clear();
  _cmkUnavailable.clear();
}
