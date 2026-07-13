// ===========================================================
// RENEX Cloudflare Worker Entry-Point
// ===========================================================
// Worker dispatch: receives all HTTP + WebSocket requests, routes
// to src/routes/* and src/cron.js (scheduled). Wrangler binds this
// file as `main` per wrangler.toml (see wrangler.toml.example).
// ===========================================================

import { json, corsHeaders } from './src/utils.js';
import { handleWsRoutes } from './src/routes/wsRoutes.js';
import { handleE2eRoutes } from './src/routes/e2eRoutes.js';
import { handleRecoveryRoutes } from './src/routes/recoveryRoutes.js';
import { handleChatRoutes } from './src/routes/chatRoutes.js';
import { handleAuthRoutes } from './src/routes/authRoutes.js';
import { handleContactRoutes } from './src/routes/contactRoutes.js';
import { handleAutoDeleteRoutes } from './src/routes/autoDeleteRoutes.js';
import { handleGroupRoutes } from './src/routes/groupRoutes.js';
import { handleServerRoutes } from './src/routes/serverRoutes.js';
import { handleNotificationRoutes } from './src/routes/notificationRoutes.js';
import { handlePresenceRoutes } from './src/routes/presenceRoutes.js';
import { handleUploadRoutes } from './src/routes/uploadRoutes.js';
import { handleGifRoutes } from './src/routes/gifRoutes.js';
import { handleInviteRoutes } from './src/routes/inviteRoutes.js';
import { handlePushRoutes } from './src/routes/pushRoutes.js';
import { handleFeedbackRoutes } from './src/routes/feedbackRoutes.js';
import { handleVoiceRoutes } from './src/routes/voiceRoutes.js';
import { scheduled } from './src/cron.js';
import { runBackfillDevices } from './src/scripts/backfillDevices.js';
import { Toucan } from 'toucan-js';

// Cloudflare Durable Object binding requirement — must be re-exported from entry point
export { UserSessionDO } from './src/auth.js';
export { RateLimiterDO } from './src/rateLimiterDO.js';
export { PrekeyDO } from './src/prekeyDO.js';

// ── SENTRY (Error-Tracking) ──────────────────────────────
// DSN als Wrangler-Secret setzen: npx wrangler secret put SENTRY_DSN
// Wenn nicht gesetzt → no-op (kein Fehler, nur kein Tracking).
function makeSentry(request, env, ctx) {
  if (!env.SENTRY_DSN) return null;
  try {
    return new Toucan({
      dsn: env.SENTRY_DSN,
      context: ctx,
      request,
      environment: env.ENVIRONMENT || 'production',
      release: env.APP_VERSION || 'unknown',
      // Sample-Rate: 100% Errors, 10% Performance (Cost-Optimierung)
      tracesSampleRate: 0.1,
      // PII-Schutz: keine User-Daten leaken. `handle` (= Identität) NICHT mehr
      // whitelisten — ging bisher als Query-Param an Sentry-EU. cf-ray (Request-ID)
      // bleibt für Debugging.
      requestDataOptions: {
        allowedHeaders: ['cf-ray'],
        allowedSearchParams: [],
      },
    });
  } catch {
    return null;
  }
}

async function fetch(request, env, ctx) {
  // PRE-FLIGHT
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const sentry = makeSentry(request, env, ctx);

  try {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    const params = url.searchParams;

    if (path.startsWith('/invite/')) {
      return await handleInviteRoutes(request, env, path, params);
    }
    if (path.startsWith('/upload/')) {
      return await handleUploadRoutes(request, env, path, params);
    }
    if (path.startsWith('/gif/')) {
      return await handleGifRoutes(request, env, path, params);
    }
    if (path === '/chat/ws' || path === '/chat/control' || path === '/chat/test') {
      return await handleWsRoutes(request, env, path, params);
    }
    if (path.startsWith('/e2e/recovery/')) {
      return await handleRecoveryRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/keys/') || path.startsWith('/e2e/')) {
      return await handleE2eRoutes(request, env, path, params);
    }
    if (path === '/chat/auto-delete') {
      return await handleAutoDeleteRoutes(request, env, path, params);
    }
    if (path.startsWith('/chat/')) {
      return await handleChatRoutes(request, env, path, params, ctx);
    }
    if (path.startsWith('/auth/') || path.startsWith('/users/') || path === '/account') {
      return await handleAuthRoutes(request, env, path, params);
    }
    if (path.startsWith('/contacts')) {
      return await handleContactRoutes(request, env, path, params);
    }
    if (path.startsWith('/groups')) {
      return await handleGroupRoutes(request, env, path, params);
    }
    if (path.startsWith('/servers/')) {
      return await handleServerRoutes(request, env, path, params);
    }
    if (path.startsWith('/notifications')) {
      return await handleNotificationRoutes(request, env, path);
    }
    if (path.startsWith('/presence')) {
      return await handlePresenceRoutes(request, env, path);
    }
    if (path.startsWith('/push/')) {
      return await handlePushRoutes(request, env, path);
    }
    if (path.startsWith('/feedback/')) {
      return await handleFeedbackRoutes(request, env, path, params);
    }
    if (path.startsWith('/voice/')) {
      return await handleVoiceRoutes(request, env, path, params, ctx);
    }
    // Sentry-Config (publik — DSN ist Public-Token, kein Secret)
    if (path === '/sentry-config') {
      return json(request, { dsn: env.SENTRY_DSN_FRONTEND || null });
    }
    // Admin: One-shot Backfill (Spec: docs/MULTI_DEVICE.md §7.1)
    // Gated durch env.ADMIN_TOKEN. Idempotent — kann mehrfach ausgeführt werden.
    if (path === '/admin/backfill-devices') {
      if (request.method !== 'POST') {
        return json(request, { error: 'POST required' }, 405);
      }
      const auth = request.headers.get('authorization') || '';
      const token = auth.replace(/^bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json(request, { error: 'Unauthorized' }, 401);
      }
      const stats = await runBackfillDevices(env);
      return json(request, { ok: true, stats });
    }
    return json(request, { error: 'Not found' }, 404);

  } catch (e) {
    console.error("WORKER CRASH", e);
    if (sentry) {
      try { sentry.captureException(e); } catch {}
    }
    return json(request, { error: "Internal server error" }, 500);
  }
}

export default { fetch, scheduled };
