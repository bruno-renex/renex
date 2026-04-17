import { json, readJson, checkCsrf } from '../utils.js';
import { rateLimit, requireSession } from '../auth.js';

const ALLOWED_CATEGORIES = ['bug', 'feature', 'lob', 'allgemein'];

async function hashIp(ip) {
  const data = new TextEncoder().encode(ip || 'unknown');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleFeedbackRoutes(request, env, path, params) {
  const csrfErr = checkCsrf(request);
  if (csrfErr) return csrfErr;

  switch (path) {

    // ── PUBLIC: Feedback einreichen ─────────────────────
    case '/feedback/submit': {
      if (request.method !== 'POST') break;

      // Progressive Rate Limit per IP:
      //   1st message: immediately
      //   2nd message: after 5 min cooldown
      //   3rd+: after 30 min cooldown
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ipHash = await hashIp(ip);
      const countKey = `feedback_count:${ipHash}`;
      const cooldownKey = `feedback_cd:${ipHash}`;

      // Check active cooldown
      const activeCooldown = await env.RENEX_KV.get(cooldownKey);
      if (activeCooldown) {
        const waitSec = Math.ceil((Number(activeCooldown) - Date.now()) / 1000);
        const waitMin = Math.ceil(waitSec / 60);
        return json(request, {
          error: `Please wait ${waitMin} more minute${waitMin !== 1 ? 's' : ''} before submitting again.`,
          retryAfter: Number(activeCooldown),
        }, 429);
      }

      // Turnstile Bot-Schutz
      const body = await readJson(request);
      if (!body) return json(request, { error: 'Invalid JSON' }, 400);

      const cfToken = body.cfTurnstileToken;
      if (!cfToken) return json(request, { error: 'Bot verification required' }, 400);

      const tsSecret = env.TURNSTILE_SECRET || '1x0000000000000000000000000000000AA';
      const formData = new URLSearchParams();
      formData.append('secret', tsSecret);
      formData.append('response', cfToken);
      formData.append('remoteip', ip);

      const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      });
      const tsData = await tsRes.json().catch(() => ({}));
      if (!tsData.success) return json(request, { error: 'Bot verification failed' }, 403);

      // Validierung
      const message = String(body.message || '').trim();
      if (message.length < 10 || message.length > 2000) {
        return json(request, { error: 'Message must be between 10 and 2000 characters.' }, 400);
      }

      const category = ALLOWED_CATEGORIES.includes(body.category) ? body.category : 'allgemein';
      const name = String(body.name || '').trim().slice(0, 50) || 'Anonymous';

      await env.RENEX_DB.prepare(
        'INSERT INTO feedback (name, category, message, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(name, category, message, ipHash, Date.now()).run();

      // Progressive cooldown: count submissions in rolling 1h window
      const rawCount = await env.RENEX_KV.get(countKey);
      const count = rawCount ? Number(rawCount) + 1 : 1;
      await env.RENEX_KV.put(countKey, String(count), { expirationTtl: 3600 });

      // Set cooldown based on submission count
      //   after 1st: 5 min cooldown
      //   after 2nd+: 30 min cooldown
      if (count >= 2) {
        const cd = Date.now() + 30 * 60_000;
        await env.RENEX_KV.put(cooldownKey, String(cd), { expirationTtl: 1800 });
      } else {
        const cd = Date.now() + 5 * 60_000;
        await env.RENEX_KV.put(cooldownKey, String(cd), { expirationTtl: 300 });
      }

      return json(request, { ok: true });
    }

    // ── AUTH: Feedback-Statistiken (Admin) ──────────────
    case '/feedback/stats': {
      if (request.method !== 'GET') break;

      const session = await requireSession(request, env);
      if (!session) return json(request, { error: 'Not authenticated' }, 401);

      const counts = await env.RENEX_DB.prepare(
        'SELECT category, COUNT(*) as count FROM feedback GROUP BY category'
      ).all();

      const recent = await env.RENEX_DB.prepare(
        'SELECT id, name, category, message, created_at FROM feedback ORDER BY created_at DESC LIMIT 50'
      ).all();

      return json(request, {
        counts: counts.results,
        recent: recent.results,
      });
    }

    default:
      break;
  }

  return json(request, { error: 'Not found' }, 404);
}
