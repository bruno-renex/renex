// ======================================================
// Guest Display Names — deterministisch aus Handle
// ======================================================
// guest_3a7f…  →  "Guest Blue Eagle"   (16 adj × 16 animals = 256 combos)
//
// Port aus renex-legacy/js/shared/guestUtils.js — identische Algorithmus,
// damit Vanilla- und Svelte-Frontend dieselbe Anzeige für gleichen Handle
// erzeugen (User auf alter /chat-Seite sieht denselben Namen wie auf
// neuer Svelte-App).
// ======================================================

const _GUEST_ADJ = [
  'Blue', 'Red', 'Green', 'Golden', 'Silver', 'Wild', 'Swift', 'Brave',
  'Dark', 'Bold', 'Calm', 'Fierce', 'Quiet', 'Sharp', 'Bright', 'Eager',
];
const _GUEST_ANI = [
  'Eagle', 'Fox', 'Lynx', 'Bear', 'Wolf', 'Falcon', 'Otter', 'Cheetah',
  'Raven', 'Hawk', 'Tiger', 'Panther', 'Puma', 'Cobra', 'Bison', 'Jaguar',
];

/**
 * Erzeugt aus einem Gast-Handle einen deterministischen Anzeigenamen.
 * Nicht-Gast-Handles werden unverändert zurückgegeben.
 *
 * @param {string} handle - z.B. "guest_3a7f5b9c"
 * @returns {string} z.B. "Guest Blue Eagle" oder unverändert wenn kein Gast
 */
export function guestDisplayName(handle) {
  if (!handle || typeof handle !== 'string') return handle || '';
  if (!handle.startsWith('guest_')) return handle;
  const hex = handle.slice(6);
  const a = parseInt(hex.slice(0, 2) || '0', 16) % _GUEST_ADJ.length;
  const b = parseInt(hex.slice(2, 4) || '0', 16) % _GUEST_ANI.length;
  return `Guest ${_GUEST_ADJ[a]} ${_GUEST_ANI[b]}`;
}

/** Convenience: prüft ob ein Handle ein Gast ist. */
export function isGuestHandle(handle) {
  return typeof handle === 'string' && handle.startsWith('guest_');
}

/**
 * Resolved-Name-Helper: gibt den besten verfügbaren Anzeigenamen zurück.
 *  - Gast → "Guest Blue Eagle"
 *  - Echter User mit DN → DN
 *  - Echter User ohne DN → @handle
 *
 * @param {string} handle
 * @param {string|null} displayName
 */
export function resolveContactName(handle, displayName = null) {
  if (!handle) return '';
  if (isGuestHandle(handle)) return guestDisplayName(handle);
  return displayName || `@${handle}`;
}
