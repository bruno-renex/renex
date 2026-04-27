# Sentry Setup für RENEX

## Schritt 1: Sentry-Account erstellen

1. Gehe zu https://sentry.io/signup/
2. Wähle "Open Source / Hobby" Plan (Free Tier: 5'000 Events/Monat)
3. Verifiziere E-Mail
4. Account erstellen

## Schritt 2: Zwei Projekte anlegen

Sentry hat getrennte DSNs für Frontend und Backend.

### Frontend-Projekt
1. New Project → JavaScript → "renex-frontend"
2. DSN kopieren (Format: `https://abc123@oXYZ.ingest.sentry.io/12345`)
3. **Das ist der `SENTRY_DSN_FRONTEND` Wert**

### Backend-Projekt
1. New Project → JavaScript / Node.js → "renex-backend"
2. DSN kopieren
3. **Das ist der `SENTRY_DSN` Wert**

## Schritt 3: Wrangler-Vars setzen

```bash
cd "/Users/brunohochstrasser/Library/Mobile Documents/com~apple~CloudDocs/16.03. renex Kopie/app.renex"

# Backend-DSN als Secret (privat, nur Backend nutzt)
npx wrangler secret put SENTRY_DSN
# → DSN einfügen, Enter

# Frontend-DSN als Var (publik — Frontend braucht es im Browser)
# In wrangler.toml unter [vars] hinzufügen:
#   SENTRY_DSN_FRONTEND = "https://...@...ingest.sentry.io/..."
```

Oder direkt in `wrangler.toml`:

```toml
[vars]
VAPID_PUBLIC_KEY = "..."
VAPID_SUBJECT = "..."
SENTRY_DSN_FRONTEND = "https://YOUR_FRONTEND_DSN_HERE"
ENVIRONMENT = "production"
```

## Schritt 4: Deploy

```bash
bash deploy.sh
```

## Schritt 5: Verifizieren

1. Frontend in Browser öffnen → DevTools → Console
2. Sollte erscheinen: `📊 Sentry ready (release=2026-04-27-X)`
3. Test-Error provozieren:
   ```js
   throw new Error("RENEX Sentry Test")
   ```
4. In Sentry-Dashboard → Issues → Error sollte innerhalb 30 Sek erscheinen

## Privacy-Konfiguration

RENEX-Sentry-Setup ist privacy-optimiert:

✅ **Keine PII gesendet** — User-Handles als anonyme IDs
✅ **Keine Message-Inhalte** — beforeSend filtert sensible URLs
✅ **Keine Crypto-Keys** — `/chat/keys/`, `/e2e/`, `/push/` URLs werden gestripped
✅ **Kein Performance-Tracking** im Frontend (Bandbreite sparen)
✅ **10% Performance-Tracking** im Backend (Cost-Optimierung)

## Was getrackt wird

- JavaScript-Errors mit Stack-Trace
- Network-Errors (fetch failures)
- Worker-Crashes mit Request-Context
- Release-Tag (für Regression-Tracking nach Deploys)

## Was NICHT getrackt wird

- ❌ User-Eingaben
- ❌ Message-Inhalte
- ❌ Verschlüsselte Payloads
- ❌ Auth-Tokens
- ❌ E-Mail/Phone (haben wir eh nicht)

## Free-Tier-Limits

- 5'000 Events/Monat
- 7-Tage Daten-Retention
- 1 User
- Reicht für Beta-Phase (bis ~5k aktive User)

## Bei mehr Bedarf

Team Plan: $26/Monat
- 50'000 Events/Monat
- 30-Tage Retention
- Unlimited Users
- Reicht für Year 2

## Test-Befehle

```bash
# Test ob Backend-DSN gesetzt ist
npx wrangler secret list | grep SENTRY

# Backend-Crash provozieren
curl https://api.renex.id/this-route-does-not-exist-and-should-404
# (404 ist kein Sentry-Event, nur ein returnter Error)

# Echter Crash-Test (auskommentieren in backend.js):
# throw new Error("RENEX Sentry Backend Test")
```
