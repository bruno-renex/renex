// ======================================================
// Member-Actions Store — globales Action-Sheet für Group-Member
// ======================================================
// Wird geöffnet wenn der User auf den Sender-Namen einer Bubble in einem
// Gruppen-Chat klickt oder auf ein Item im GroupMembersModal.
//
// Zeigt statusabhängige Aktionen:
//   - Bereits Kontakt    → Direkt-Nachricht öffnen
//   - Pending eingehend  → Anfrage akzeptieren / ablehnen
//   - Pending ausgehend  → Anfrage zurückziehen
//   - Kein Kontakt       → Als Kontakt anfragen
//
// Mount: in App.svelte (genau einmal). Trigger: memberActionsStore.open(handle).
// ======================================================

let _isOpen = $state(false);
let _handle = $state(null);

export const memberActionsStore = {
  get isOpen() { return _isOpen; },
  get handle() { return _handle; },

  open(handle) {
    if (!handle || typeof handle !== 'string') return;
    _handle = handle.toLowerCase();
    _isOpen = true;
  },

  close() {
    _isOpen = false;
    // Handle nach kurzer Verzögerung clearen — sonst flackert die Anzeige
    // während der Close-Animation.
    setTimeout(() => { _handle = null; }, 200);
  },
};
