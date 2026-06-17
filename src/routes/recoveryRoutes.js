import { json, readJson, param } from '../utils.js';
import { requireSession, rateLimit } from '../auth.js';

// ======================================================
// RECOVERY ROUTES: /e2e/recovery/*
// Spec: docs/RECOVERY.md §9, §10.2
//
// Storage:
//   R2 recovery/<handle>.salt   → 16 random bytes (init-only, never overwritten)
//   R2 recovery/<handle>.bin    → AES-GCM encrypted bundle (IV-prefixed binary)
//   KV user:recovery:<handle>   → JSON { verified: 0|1, shown_at: number }
//
// User-Daten leben in KV (nicht D1) — folgt RENEX-Konvention
// (siehe user:terms:<handle>, profile:<handle> etc.)
// ======================================================

const MAX_BUNDLE_SIZE = 256 * 1024;  // 256 KB hard-limit (Spec §8)
const SALT_SIZE       = 16;          // Bytes

function recoveryMetaKey(handle) {
  return `user:recovery:${handle}`;
}

async function readRecoveryMeta(env, handle) {
  const raw = await env.RENEX_KV.get(recoveryMetaKey(handle));
  if (!raw) return { verified: 0, shown_at: null };
  try {
    const m = JSON.parse(raw);
    return {
      verified: m.verified === 1 ? 1 : 0,
      shown_at: typeof m.shown_at === 'number' ? m.shown_at : null,
    };
  } catch {
    return { verified: 0, shown_at: null };
  }
}

async function writeRecoveryMeta(env, handle, meta) {
  await env.RENEX_KV.put(recoveryMetaKey(handle), JSON.stringify(meta));
}

export async function handleRecoveryRoutes(request, env, path, params) {
  switch (path) {

    // ======================================================
    // INIT: One-shot Salt-Write beim Register
    // POST /e2e/recovery/init { salt: <base64 16 bytes> }
    // Refuses if salt already exists (recovery-init darf nur 1×)
    // ======================================================
    case "/e2e/recovery/init": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);
        const handle = session.handle;

        if (!env.RENEX_FILES) return json(request, { error: "R2 not configured" }, 503);

        // Rate-Limit: Init wird normalerweise 1× pro Lifetime aufgerufen.
        // 5/h pro User reicht und schützt gegen Bug-Schleifen.
        const rl = await rateLimit(env, `recovery_init:${handle}`, 3600_000, 5, { strict: true });
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);
        const saltB64 = String(body.salt || "");
        if (!saltB64) return json(request, { error: "Missing salt" }, 400);

        // Decode + Validate Salt-Größe
        let saltBytes;
        try {
          const bin = atob(saltB64);
          saltBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) saltBytes[i] = bin.charCodeAt(i);
        } catch {
          return json(request, { error: "Invalid salt encoding" }, 400);
        }
        if (saltBytes.length !== SALT_SIZE) {
          return json(request, { error: `Salt must be ${SALT_SIZE} bytes` }, 400);
        }

        // Idempotenz: wenn Salt schon existiert → 409 (User soll bestehenden nutzen)
        const existing = await env.RENEX_FILES.head(`recovery/${handle}.salt`);
        if (existing) {
          return json(request, { error: "Salt already exists", code: "salt_exists" }, 409);
        }

        await env.RENEX_FILES.put(`recovery/${handle}.salt`, saltBytes, {
          httpMetadata: { contentType: "application/octet-stream" }
        });

        // Phrase-shown Marker setzen (User hat gerade Phrase gesehen beim Register)
        const meta = await readRecoveryMeta(env, handle);
        meta.shown_at = Date.now();
        await writeRecoveryMeta(env, handle, meta);

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // BUNDLE: GET → returnt salt + blob für Recovery / Re-Verify
    // PUT  → schreibt neuen verschlüsselten Blob (Body = binary)
    // ======================================================
    case "/e2e/recovery/bundle": {
      const session = await requireSession(request, env);
      if (!session) return json(request, { error: "Not authenticated" }, 401);
      const handle = session.handle;

      if (!env.RENEX_FILES) return json(request, { error: "R2 not configured" }, 503);

      if (request.method === "GET") {
        const rl = await rateLimit(env, `recovery_bundle_get:${handle}`, 60_000, 5);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const [saltObj, blobObj] = await Promise.all([
          env.RENEX_FILES.get(`recovery/${handle}.salt`),
          env.RENEX_FILES.get(`recovery/${handle}.bin`),
        ]);

        if (!saltObj) {
          return json(request, { error: "no_salt", message: "Recovery not initialized" }, 404);
        }

        const saltBytes = new Uint8Array(await saltObj.arrayBuffer());
        const saltB64 = btoa(String.fromCharCode(...saltBytes));

        let blobB64 = null;
        let ts = null;
        if (blobObj) {
          const blobBytes = new Uint8Array(await blobObj.arrayBuffer());
          // Base64-encode (chunked für große Blobs)
          let s = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < blobBytes.length; i += CHUNK) {
            s += String.fromCharCode(...blobBytes.subarray(i, i + CHUNK));
          }
          blobB64 = btoa(s);
          ts = blobObj.uploaded ? blobObj.uploaded.getTime() : null;
        }

        return json(request, {
          ok: true,
          salt: saltB64,
          blob: blobB64,
          ts,
        });
      }

      if (request.method === "POST" || request.method === "PUT") {
        const rl = await rateLimit(env, `recovery_bundle_put:${handle}`, 3600_000, 6);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await request.arrayBuffer();
        if (!body || body.byteLength === 0) {
          return json(request, { error: "Empty body" }, 400);
        }
        if (body.byteLength > MAX_BUNDLE_SIZE) {
          return json(request, { error: "Bundle too large", maxBytes: MAX_BUNDLE_SIZE }, 413);
        }

        await env.RENEX_FILES.put(`recovery/${handle}.bin`, body, {
          httpMetadata: { contentType: "application/octet-stream" }
        });

        return json(request, { ok: true, ts: Date.now(), bytes: body.byteLength });
      }

      break;
    }

    // ======================================================
    // VERIFY: Markiert Phrase als bestätigt (Frontend-getrieben)
    // POST /e2e/recovery/verify { verified: true }
    // Server vertraut Frontend hier — echter Beweis ist Decrypt-Test (§9)
    // ======================================================
    case "/e2e/recovery/verify": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);
        const handle = session.handle;

        // Anti-Brute-Force-Limit: 5/h ist ausreichend (Spec §8 Edge 5)
        const rl = await rateLimit(env, `recovery_verify:${handle}`, 3600_000, 5, { strict: true });
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await readJson(request);
        if (!body || body.verified !== true) {
          return json(request, { error: "Invalid body" }, 400);
        }

        const meta = await readRecoveryMeta(env, handle);
        meta.verified = 1;
        await writeRecoveryMeta(env, handle, meta);

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // STATUS: Frontend-Bootstrap-Check
    // GET /e2e/recovery/status
    // → { hasBundle, hasSalt, verified, shownAt }
    // ======================================================
    case "/e2e/recovery/status": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);
        const handle = session.handle;

        if (!env.RENEX_FILES) return json(request, { error: "R2 not configured" }, 503);

        const rl = await rateLimit(env, `recovery_status:${handle}`, 60_000, 30);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const [saltHead, bundleHead, meta] = await Promise.all([
          env.RENEX_FILES.head(`recovery/${handle}.salt`),
          env.RENEX_FILES.head(`recovery/${handle}.bin`),
          readRecoveryMeta(env, handle),
        ]);

        return json(request, {
          ok: true,
          hasSalt: !!saltHead,
          hasBundle: !!bundleHead,
          verified: meta.verified === 1,
          shownAt: meta.shown_at,
        });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
