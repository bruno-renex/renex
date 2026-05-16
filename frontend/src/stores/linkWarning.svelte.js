// ======================================================
// Link-Warning Store — globales Modal für verdächtige externe Links
// ======================================================
// Wird geöffnet wenn analyzeLink() einen Link als unsafe einstuft.
// Mount: LinkWarningModal in App.svelte (genau einmal).
// Trigger: openExternalLink(href) in MessageBubble (oder anderswo).
// ======================================================
import { analyzeLink } from '../lib/linkSafety.js';

let _isOpen = $state(false);
let _href = $state('');
let _analysis = $state(null);

export const linkWarningStore = {
  get isOpen() { return _isOpen; },
  get href() { return _href; },
  get analysis() { return _analysis; },

  open(href, analysis) {
    _href = href;
    _analysis = analysis;
    _isOpen = true;
  },

  close() {
    _isOpen = false;
    setTimeout(() => {
      _href = '';
      _analysis = null;
    }, 200);
  },

  /**
   * User hat "Trotzdem öffnen" geklickt.
   * Öffnet den Link in neuem Tab mit Privacy-Attributen und schließt das Modal.
   */
  confirmOpen() {
    if (_href) {
      // window.open mit noopener — kein referrer leak
      const w = window.open(_href, '_blank', 'noopener,noreferrer');
      // Fallback falls Popup-Blocker zuschlägt
      if (!w) {
        const a = document.createElement('a');
        a.href = _href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        a.referrerPolicy = 'no-referrer';
        a.click();
      }
    }
    this.close();
  },
};

/**
 * Zentraler Entry-Point für externe Link-Klicks.
 * - Sichere Links: öffnen direkt
 * - Verdächtige Links: zeigen Warnmodal
 *
 * @param {string} href
 */
export function openExternalLink(href) {
  const analysis = analyzeLink(href);
  if (analysis.safe) {
    // Direkt öffnen — Default-Verhalten des <a target="_blank">
    // hat das bereits getan; diese Funktion wird nur aufgerufen wenn
    // wir preventDefault gesetzt haben (siehe MessageBubble).
    const w = window.open(href, '_blank', 'noopener,noreferrer');
    if (!w) {
      // Popup-Blocker-Fallback
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.referrerPolicy = 'no-referrer';
      a.click();
    }
    return;
  }
  linkWarningStore.open(href, analysis);
}
