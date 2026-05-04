#!/bin/bash
# ─────────────────────────────────────────────
#  RENEX Deploy Script (Phase 1A.6.6 Cutover — Svelte)
#
#  Deployed:
#   - Backend (api.renex.id)
#   - Frontend Svelte-Build (app.renex.id, project "renex-static")
#
#  Vanilla-Codebase ist archiviert in /renex-legacy/.
#  Rollback: siehe /renex-legacy/_DEPRECATED.md
#
#  Aufruf:
#    bash deploy.sh           # Voller Deploy (Tests + Build + Backend + Frontend)
#    bash deploy.sh --skip-tests  # Schneller Deploy ohne Tests (NICHT empfohlen)
# ─────────────────────────────────────────────

set -e

APP_DIR="/Users/brunohochstrasser/Library/Mobile Documents/com~apple~CloudDocs/16.03. renex Kopie/app.renex"
DIST="$APP_DIR/frontend/dist"
PUBLIC="$APP_DIR/frontend/public"  # Vite kopiert public/ automatisch in dist/ — Source-of-Truth für Static Assets
PAGES_PROJECT="renex-static"        # Production Pages-Project

cd "$APP_DIR"

# ── 1. Tests laufen (außer --skip-tests) ──────────
if [ "$1" != "--skip-tests" ]; then
  echo "▶ Running tests…"
  npm test || { echo "❌ Tests failed — Deploy abgebrochen"; exit 1; }
fi

# ── 2. Version berechnen ───────────────────────────
# Quelle der Wahrheit: frontend/public/version.json (Vite-public → wird auto in dist kopiert)
VERSION_FILE="$PUBLIC/version.json"
CURRENT=$(python3 -c "
import json
d = json.load(open('$VERSION_FILE'))
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

echo "Version: $CURRENT → $NEW"

# ── 3. version.json updaten + meta-Tag in HTML ────
python3 -c "
import json
path = '$VERSION_FILE'
d = json.load(open(path))
d['version'] = '$NEW'
open(path, 'w').write(json.dumps(d, indent=2) + '\n')
"

# Svelte-index.html Meta-Version setzen (für Sentry-Release + Update-Banner)
sed -i '' "s/name=\"renex-version\" content=\"[^\"]*\"/name=\"renex-version\" content=\"$NEW\"/" \
  "$APP_DIR/frontend/index.html"

echo "Version aktualisiert: $NEW"

# ── 4. Svelte Build ────────────────────────────────
echo ""
echo "▶ Building Svelte-Frontend (Vite)…"
npm run build

if [ ! -d "$DIST" ]; then
  echo "❌ Build-Output fehlt: $DIST"
  exit 1
fi

# ── 5. Static Assets ───────────────────────────────
# Vite kopiert frontend/public/ automatisch in dist/ (sw.js, manifest.json,
# _headers, _redirects, version.json, icons/, sub-pages/). Kein manueller cp
# mehr nötig — Source-of-Truth ist frontend/public/.
# version.json wurde oben (Schritt 3) bereits in $PUBLIC aktualisiert,
# Vite hat im Build die aktuelle Version nach $DIST/version.json kopiert.

# ── 6. Deploy Backend ──────────────────────────────
echo ""
echo "▶ Deploying Backend-Worker (api.renex.id)…"
npx wrangler deploy

# ── 7. Deploy Frontend ─────────────────────────────
echo ""
echo "▶ Deploying Frontend Svelte (app.renex.id)…"
npx wrangler pages deploy "$DIST" --project-name "$PAGES_PROJECT" --commit-dirty=true

echo ""
echo "✅ Deploy fertig! Version $NEW ist live."
echo "   → Frontend: https://app.renex.id (Svelte)"
echo "   → Backend:  https://api.renex.id"
echo "   → Static Assets: frontend/public/  (Vanilla-Code-Reference: /renex-legacy/)"
