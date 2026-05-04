# ⚠️ DEPRECATED — Vanilla Frontend (Phase 1A.6 Migration)

Dieses Verzeichnis war die ursprüngliche Vanilla-JS-Codebase von RENEX.
Mit Phase 1A.6 wurde alles nach Svelte 5 migriert (`/frontend/`).

## Status: REIN ARCHIV / CODE-REFERENZ

Seit dem 2026-05-03 sind die Static-Assets (sw.js, manifest.json, _headers,
_redirects, version.json, colors.css, icons/, alle Sub-Pages) nach
`frontend/public/` umgezogen — Vite ist jetzt Source-of-Truth.

Was hier verbleibt sind reine Code-Referenzen für Phase 1B:

- `index.html`, `inbox.html`, `mockup-panel.html` — alte Vanilla-Seiten
- `js/` — Vanilla-JS (Voice-WebRTC, E2E-Encrypt, etc.) — wird von
  `tests/chatCrypto.test.js` noch direkt importiert (Migrations-Verifikation).

**KEINE der Files hier wird mehr deployed.** Wer in Phase 1B das Voice-WebRTC
oder andere noch-zu-portierende Module sucht, findet sie unter `js/`.

## Rollback ist NICHT mehr möglich

Stand 2026-05-03 hat sich das Backend (CMK-System, Bundle-Sync, Edit/Delete/
Reactions, Reply-Quotes etc.) so weit weiterentwickelt, dass die Vanilla-
Codebase nicht mehr produktions-tauglich ist. `deploy.sh.legacy` würde mit
dem aktuellen Worker nicht mehr sauber zusammenarbeiten.

Falls ein Production-Problem auftritt: Rollback per Cloudflare-Pages-UI
auf einen früheren Svelte-Deployment, NICHT auf das Vanilla-Verzeichnis.

## Lifecycle

- **2026-04-28:** Vanilla archiviert (Phase 1A.6.6 Cutover)
- **2026-05-03:** Static-Assets nach `frontend/public/` umgezogen
- **Nach Phase 1B:** Verzeichnis vollständig löschbar (sobald Voice-WebRTC
  nach Svelte portiert ist und chatCrypto-Test direkt gegen frontend/src
  läuft)
