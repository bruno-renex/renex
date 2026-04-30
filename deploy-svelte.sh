#!/bin/bash
# ─────────────────────────────────────────────
#  RENEX Svelte-Deploy Script (Phase 1A.6 Migration)
#  Buildet Svelte-Frontend + deployed parallel zur Vanilla-Version.
#
#  ⚠️  Während Migration: Vanilla bleibt live unter app.renex.id.
#       Svelte-Version unter svelte-renex.pages.dev (test-URL).
#
#  Aufruf:
#    bash deploy-svelte.sh           # Build + Deploy Svelte
#    bash deploy-svelte.sh --build   # Nur Build, kein Deploy
#
#  Cutover (wenn Svelte stable):
#    1. Cloudflare-Pages-Project "renex-svelte" → Custom Domain anschalten
#    2. ODER: deploy.sh aktualisieren (frontend/dist statt renex/)
#    3. /renex/ Vanilla-Verzeichnis archivieren
# ─────────────────────────────────────────────

set -e

APP_DIR="/Users/brunohochstrasser/Library/Mobile Documents/com~apple~CloudDocs/16.03. renex Kopie/app.renex"
DIST="$APP_DIR/frontend/dist"
# `renex-static` ist das Pages-Project mit Custom-Domain `app.renex.id` (= production).
# `renex-svelte` ist nur Test-URL ohne Custom-Domain — kann via DEPLOY_TARGET=svelte
# überschrieben werden für Staging-Tests.
PAGES_PROJECT="${DEPLOY_TARGET:-renex-static}"

cd "$APP_DIR"

# ── 1. Tests laufen (Crypto-Code) ──────────────
echo "▶ Running tests…"
npm test || { echo "❌ Tests failed — Deploy abgebrochen"; exit 1; }

# ── 2. Version berechnen (gleiche Logik wie deploy.sh) ────
RENEX="$APP_DIR/renex-legacy"
CURRENT=$(python3 -c "
import json
d = json.load(open('$RENEX/version.json'))
print(d['version'])
")

NEW=$(python3 -c "
from datetime import date
v = '$CURRENT'
today = date.today().strftime('%Y-%m-%d')
parts = v.rsplit('-', 1)
if parts[0] == today:
    new = today + '-' + str(int(parts[1]) + 1)
else:
    new = today + '-1'
print(new)
")

echo "Svelte-Build Version: $NEW"

# ── 3. Version in index.html der Svelte-App injizieren ──
# Damit Sentry-Release-Tag stimmt und PWA-Update-Banner funktioniert.
sed -i '' "s/name=\"renex-version\" content=\"[^\"]*\"/name=\"renex-version\" content=\"$NEW\"/" \
  "$APP_DIR/frontend/index.html"

# ── 4. Build ───────────────────────────────────
echo ""
echo "▶ Building Svelte (Vite)…"
npm run build

if [ ! -d "$DIST" ]; then
  echo "❌ Build-Output fehlt: $DIST"
  exit 1
fi

# Falls --build: hier abbrechen
if [ "$1" = "--build" ]; then
  echo "✅ Build fertig. Output: $DIST"
  exit 0
fi

# ── 5. Static Files vom Vanilla nach dist kopieren ──────
# Svelte-Build erzeugt nur HTML/JS/CSS. Static Assets wie:
#   - /sw.js         (Service Worker)
#   - /manifest.json (PWA-Manifest)
#   - /icons/*.png
#   - /_headers      (CSP, Caching)
#   - /_redirects
#   - /version.json
# Werden vom Vanilla-/renex/ kopiert (existieren dort bereits).
echo ""
echo "▶ Static Assets aus /renex kopieren (sw.js, icons, manifest, _headers)…"
for f in sw.js manifest.json _headers _redirects version.json colors.css renex-logo.svg; do
  [ -f "$RENEX/$f" ] && cp "$RENEX/$f" "$DIST/$f"
done
[ -d "$RENEX/icons" ] && cp -r "$RENEX/icons" "$DIST/icons"

# Update version.json mit neuer Version
python3 -c "
import json
path = '$DIST/version.json'
d = json.load(open(path))
d['version'] = '$NEW'
open(path, 'w').write(json.dumps(d, indent=2) + '\n')
"

# ── 6. Deploy ──────────────────────────────────
echo ""
echo "▶ Deploying Svelte-Frontend ($PAGES_PROJECT)…"
npx wrangler pages deploy "$DIST" --project-name "$PAGES_PROJECT" --commit-dirty=true

echo ""
echo "✅ Svelte-Deploy fertig! Version $NEW ist live."
if [ "$PAGES_PROJECT" = "renex-static" ]; then
  echo "   → Production: https://app.renex.id"
else
  echo "   → Staging: https://$PAGES_PROJECT.pages.dev"
  echo "   (Production app.renex.id NICHT betroffen — DEPLOY_TARGET=$PAGES_PROJECT)"
fi
