// ======================================================
// Gast-Session-Restlaufzeit: Formatierung + Warnstufe (eGov 1.2)
//
// Pure Functions — vom GuestBanner genutzt, unit-getestet
// (tests/guestTime.test.js). Vor den langlebigen Org-Invites kannte der
// Banner nur h/min/s — eine 90-Tage-Session wurde als "2160h 0min" angezeigt.
// ======================================================

// "89 Tage" (ab 48h, via daysTemplate lokalisierbar) / "1h 23min" / "45min" / "30s"
export function formatGuestRemaining(remainingMs, daysTemplate = '{n} Tage') {
  if (remainingMs === null || remainingMs === undefined) return '';
  const totalSec = Math.floor(Math.max(0, remainingMs) / 1000);
  const h = Math.floor(totalSec / 3600);
  if (h >= 48) return daysTemplate.replace('{n}', String(Math.floor(h / 24)));
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

// 'warn' im Fenster (24h, 7d] — eine langlebige Org-Session nähert sich dem
// Ende. ≤24h bleibt bewusst 'none': Consumer-Sessions leben KOMPLETT unter
// 24h, eine Warnfärbung ab Geburt wäre eine Consumer-UX-Regression
// (Scope-Freeze); Org-Gäste wurden bei 30d/7d zudem schon per System-Message
// gewarnt (Cron runGuestExpiryWarnings).
export function guestWarnLevel(remainingMs) {
  if (remainingMs === null || remainingMs === undefined || remainingMs <= 0) return 'none';
  const DAY = 86400_000;
  return (remainingMs > DAY && remainingMs <= 7 * DAY) ? 'warn' : 'none';
}
