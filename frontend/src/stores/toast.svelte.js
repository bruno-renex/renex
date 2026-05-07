// ======================================================
// Toast Store — Ephemerale UI-Notifications
// ======================================================
// Minimal: ein Stack von Toasts unten-mitte, auto-dismiss nach TTL.
// Rendering via ToastContainer.svelte (mounted in App.svelte).
//
// Verwendung:
//   import { toastStore } from './stores/toast.svelte.js';
//   toastStore.push('Sicherheits-Schlüssel rotiert', { kind: 'info', ttl: 4000 });
// ======================================================

const DEFAULT_TTL_MS = 4000;
const MAX_TOASTS     = 4;

let _toasts = $state([]);  // [{ id, text, kind, hasAction, ts }]
let _nextId = 1;

// Actions outside des reaktiven State — Svelte 5 $state-Proxy strippt sonst
// Function-Properties beim Reaktiv-Wrapping. Keyed by toast-id, gecleant
// bei dismiss/clear/auto-ttl.
const _actions = new Map();

export const toastStore = {
  get toasts() { return _toasts; },

  /**
   * @param {string} text
   * @param {{ kind?: 'info'|'success'|'warn'|'error', ttl?: number, action?: () => void }} [opts]
   *   - action: optional callback bei Click. Toast wird nach Click auto-dismissed.
   *     Wenn nicht gesetzt: Click = nur dismiss.
   * @returns {number} id (für manuelles dismiss)
   */
  push(text, opts = {}) {
    const id   = _nextId++;
    const kind = opts.kind || 'info';
    const ttl  = typeof opts.ttl === 'number' ? opts.ttl : DEFAULT_TTL_MS;
    const action = typeof opts.action === 'function' ? opts.action : null;
    const toast = { id, text: String(text), kind, hasAction: !!action, ts: Date.now() };

    if (action) _actions.set(id, action);

    // FIFO-Cap: alteste Toasts wegwerfen wenn Queue voll
    const next = [..._toasts, toast];
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift();
      _actions.delete(dropped.id);
    }
    _toasts = next;

    if (ttl > 0) {
      setTimeout(() => this.dismiss(id), ttl);
    }
    return id;
  },

  /** Führt die Action des Toasts aus (falls gesetzt) und schließt ihn. */
  trigger(id) {
    const fn = _actions.get(id);
    if (fn) {
      try { fn(); } catch {}
    }
    this.dismiss(id);
  },

  dismiss(id) {
    _toasts = _toasts.filter(t => t.id !== id);
    _actions.delete(id);
  },

  clear() {
    _toasts = [];
    _actions.clear();
  },
};
