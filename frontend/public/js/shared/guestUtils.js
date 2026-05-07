// ======================================================
// GUEST DISPLAY NAME  (deterministic, English)
// guest_3a7f… → "Blue Eagle"  (16 adj × 16 animals = 256 combos)
// ======================================================
const _GUEST_ADJ = [
  'Blue','Red','Green','Golden','Silver','Wild','Swift','Brave',
  'Dark','Bold','Calm','Fierce','Quiet','Sharp','Bright','Eager'
];
const _GUEST_ANI = [
  'Eagle','Fox','Lynx','Bear','Wolf','Falcon','Otter','Cheetah',
  'Raven','Hawk','Tiger','Panther','Puma','Cobra','Bison','Jaguar'
];

export function guestDisplayName(handle) {
  if (!handle?.startsWith('guest_')) return handle;
  const hex = handle.slice(6); // strip "guest_"
  const a = parseInt(hex.slice(0, 2) || '0', 16) % _GUEST_ADJ.length;
  const b = parseInt(hex.slice(2, 4) || '0', 16) % _GUEST_ANI.length;
  return `Guest ${_GUEST_ADJ[a]} ${_GUEST_ANI[b]}`;
}

// Replace every raw guest_… token in a text string (for system messages)
export function replaceGuestHandles(text) {
  return String(text).replace(/\bguest_[0-9a-f]+\b/gi, h => guestDisplayName(h));
}
