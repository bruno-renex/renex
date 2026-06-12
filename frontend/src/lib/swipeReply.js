// ======================================================
// swipeReply — WhatsApp-Style "nach rechts wischen = antworten"
// ======================================================
// Svelte-Action für eine Nachrichten-Bubble. Löst beim klaren Rechts-Swipe die
// (bereits vorhandene) Reply-Aktion aus — zusätzlich zum Antwort-Pfeil.
//
// Konservative Scroll-Disambiguierung: die Action engagiert NUR, wenn die Geste
// eindeutig horizontal-rechts ist. Vertikales (Scroll) oder Links-Wischen wird
// sofort losgelassen, sodass das normale Listen-Scrollen unberührt bleibt.
// `touch-action: pan-y` auf der Bubble (CSS) unterstützt das zusätzlich.
//
// Parameter: onReply = () => void  — oder null/undefined, wenn nicht erlaubt
// (z.B. noch nicht gesendete Message). Reaktiv via update().

const THRESHOLD = 56;   // px bis die Reply-Aktion ausgelöst wird
const MAX_DRAG  = 72;   // max. Slide-Weg (mit Gummiband darüber hinaus)
const SLOP      = 12;   // px, bis die Richtung (h/v) entschieden wird

export function swipeReply(node, onReply) {
  let startX = 0, startY = 0, dx = 0, dir = null; // dir: null | 'h' | 'v'

  const enabled = () => typeof onReply === 'function';

  function springBack() {
    node.style.transition = 'transform 0.18s ease';
    node.style.transform = '';
    node.style.opacity = '';
    setTimeout(() => { node.style.transition = ''; }, 200);
  }

  function onStart(e) {
    if (!enabled() || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0; dir = null;
    node.style.transition = '';
  }

  function onMove(e) {
    if (!enabled() || dir === 'v') return;
    const mx = e.touches[0].clientX - startX;
    const my = e.touches[0].clientY - startY;

    if (dir === null) {
      if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return;             // noch unklar
      if (Math.abs(my) >= Math.abs(mx) || mx <= 0) { dir = 'v'; return; } // vertikal/links → Scroll
      dir = 'h';
    }

    // horizontal-rechts gesperrt → Browser-Scroll blocken + Bubble mitziehen
    e.preventDefault();
    dx = Math.min(Math.max(0, mx), MAX_DRAG);
    const shown = dx <= THRESHOLD ? dx : THRESHOLD + (dx - THRESHOLD) * 0.35; // Gummiband
    node.style.transform = `translateX(${shown}px)`;
    node.style.opacity = String(1 - (dx / MAX_DRAG) * 0.15);
  }

  function onEnd() {
    if (dir === 'h' && dx >= THRESHOLD && enabled()) {
      try { navigator.vibrate?.(12); } catch { /* nicht unterstützt → egal */ }
      onReply();
    }
    dir = null;
    springBack();
  }

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: false }); // passive:false → preventDefault erlaubt
  node.addEventListener('touchend', onEnd, { passive: true });
  node.addEventListener('touchcancel', onEnd, { passive: true });

  return {
    update(next) { onReply = next; },
    destroy() {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onEnd);
    },
  };
}
