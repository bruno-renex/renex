# ⚠️ DEPRECATED — Vanilla Frontend (Phase 1A.6 Migration)

Dieses Verzeichnis war die ursprüngliche Vanilla-JS-Codebase von RENEX.
Mit Phase 1A.6 wurde alles nach Svelte 5 migriert (`/frontend/`).

## Status: ARCHIVIERT, NICHT GELÖSCHT

**Warum behalten?**
- Rollback-Sicherheit falls Svelte-Migration kritische Bugs hat
- Reference-Code für Phase 1B (E2E-Encrypt/Decrypt-Logic, Voice-WebRTC)
- Verifikation der portierten Komponenten

## Rollback-Anleitung (Notfall)

Falls Svelte-Version Production-Probleme hat:

```bash
cd "/Users/brunohochstrasser/Library/Mobile Documents/com~apple~CloudDocs/16.03. renex Kopie/app.renex"

# Vanilla wieder als Frontend
mv renex-legacy renex

# deploy.sh.legacy ist die ursprüngliche Vanilla-Deploy-Version
cp deploy.sh.legacy deploy.sh

# Deploy
bash deploy.sh
```

## Lifecycle

- **2026-04-28:** Archiviert (Phase 1A.6.6 Cutover)
- **Nach Phase 1B:** Wahrscheinlich vollständig gelöscht
- **Frühestens:** Wenn Svelte 4 Wochen ohne Bugs in Production läuft
