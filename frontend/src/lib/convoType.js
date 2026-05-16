// ======================================================
// Convo-Type Helpers
// ======================================================
// Phase 3A führte `type='channel'` ein. Aus Krypto/Wire-Format-Sicht ist ein
// Channel **identisch** zu einer Group (Sender-Keys-Pattern, GSK pro Sender,
// convo_id = UUID). Der Unterschied ist nur, dass Channel-Members aus
// `server_members` kommen statt aus `conversation_members`.
//
// Frontend nutzt überall `chat.type === 'group'`-Checks. Statt 24 Stellen
// einzeln zu erweitern, liefert dieses Modul einen Helper.
// ======================================================

/**
 * True wenn chat eine Group ODER Channel ist — also alle Convos mit UUID-
 * key und sender-keys-Krypto (im Gegensatz zu DMs mit peer-handle-key).
 *
 * Verwendung:
 *   if (isGroupLike(chat)) { ... }   // statt: chat.type === 'group'
 *
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function isGroupLike(chat) {
  if (!chat?.type) return false;
  return chat.type === 'group' || chat.type === 'channel';
}
