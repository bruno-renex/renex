#!/bin/bash
# ─────────────────────────────────────────────
#  RENEX Deploy Script
#  Bumpt Version automatisch + deployt Frontend
#  Aufruf: bash deploy.sh
# ─────────────────────────────────────────────

set -e

APP_DIR="/Users/brunohochstrasser/Library/Mobile Documents/com~apple~CloudDocs/16.03. renex Kopie/app.renex"
RENEX="$APP_DIR/renex"

# ── 1. Aktuelle Version lesen ──────────────────
CURRENT=$(python3 -c "
import json
d = json.load(open('$RENEX/version.json'))
print(d['version'])
")

# ── 2. Neue Version berechnen (heute-N+1) ──────
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

# ── 3. version.json updaten ────────────────────
python3 -c "
import json
path = '$RENEX/version.json'
d = json.load(open(path))
d['version'] = '$NEW'
open(path, 'w').write(json.dumps(d, indent=2) + '\n')
"

# ── 4. index.html updaten (inbox.html ist nur Redirect, kein Duplikat mehr) ──
sed -i '' "s/name=\"renex-version\" content=\"[^\"]*\"/name=\"renex-version\" content=\"$NEW\"/" "$RENEX/index.html"

# ── 4b. Cache-Buster für ES-Module-Imports von auth.js bumpen ──
# Browser cachen ES-Module aggressiv nach URL. Ohne diesen Bump bleibt nach
# einem Deploy die alte auth.js im Cache hängen, neue Features greifen nicht.
sed -i '' "s|auth\\.js?v=[^\"]*|auth.js?v=$NEW|g" "$RENEX/index.html"
sed -i '' "s|auth\\.js?v=[^\"]*|auth.js?v=$NEW|g" "$RENEX/js/inbox.js"

echo "Version in index.html + version.json aktualisiert (inkl. auth.js-Cache-Buster)"

# ── 5. Deploy ──────────────────────────────────
cd "$APP_DIR"

echo ""
echo "▶ Deploying Backend-Worker (api.renex.id)…"
npx wrangler deploy

echo ""
echo "▶ Deploying Frontend (renex-static)…"
npx wrangler pages deploy renex/ --project-name renex-static --commit-dirty=true

echo ""
echo "✅ Deploy fertig! Version $NEW ist live (Backend + Frontend)."
echo "   → Auf dem Smartphone erscheint der blaue Balken automatisch."
