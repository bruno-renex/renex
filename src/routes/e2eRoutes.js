import { json, readJson, param } from '../utils.js';
import { requireSession, rateLimit, isAcceptedContact, pushToUserDO } from '../auth.js';

// ======================================================
// E2E ROUTES: /chat/keys/*, /e2e/inbox/*, /e2e/cmk/*
// ======================================================
export async function handleE2eRoutes(request, env, path, params) {
  switch (path) {

    // ======================================================
    // CHAT KEYS: UPLOAD PUBLIC KEY
    // ======================================================
    case "/chat/keys/upload": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const handle = session.handle;

        // Body
        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { jwk, deviceId } = body;

        if (!deviceId || typeof deviceId !== "string" || deviceId.length > 64) {
          return json(request, { error: "Missing/invalid deviceId" }, 400);
        }

        // Store device public key
        await env.RENEX_KV.put(
          `chat:pubkey:${handle}:${deviceId}`,
          JSON.stringify(jwk)
        );

        // optional: Index-Liste der Devices pflegen
        const idxKey = `chat:pubkeys:${handle}`;
        let idx = [];
        const rawIdx = await env.RENEX_KV.get(idxKey);
        if (rawIdx) {
          try { idx = JSON.parse(rawIdx) } catch {}
        }
        if (!idx.includes(deviceId)) idx.push(deviceId);

        await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // CHAT KEYS: GET PUBLIC KEY (privacy-safe)
    // ======================================================
    case "/chat/keys/get": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const { handle: me } = session;

        const user = (param(params, "user") || "").toLowerCase();

        if (!user || user === me) {
          return json(request, { jwk: null });
        }

        const contactRow = await env.RENEX_DB.prepare(
          "SELECT status FROM contacts WHERE user_handle = ? AND contact_handle = ? LIMIT 1"
        ).bind(me, user).first();

        if (!contactRow || contactRow.status !== "accepted") {
          return json(request, { jwk: null });
        }

        // NEW: multi-device keys
        const idxKey = `chat:pubkeys:${user}`;
        const rawIdx = await env.RENEX_KV.get(idxKey);

        let deviceIds = [];
        if (rawIdx) {
          try { deviceIds = JSON.parse(rawIdx) } catch {}
        }

        const keys = [];
        for (const deviceId of deviceIds) {
          const raw = await env.RENEX_KV.get(`chat:pubkey:${user}:${deviceId}`);
          if (!raw) continue;
          try {
            keys.push({ deviceId, jwk: JSON.parse(raw) });
          } catch {}
        }

        // BACKWARD-COMPAT: falls noch alte Single-Key Speicherung existiert
        if (keys.length === 0) {
          const legacyRaw = await env.RENEX_KV.get(`chat:pubkey:${user}`);
          if (!legacyRaw) return json(request, { keys: [] });

          try {
            keys.push({ deviceId: "legacy", jwk: JSON.parse(legacyRaw) });
          } catch {}
        }

        return json(request, {
          devices: keys
        });
      }
      break;
    }

    // ======================================================
    // INBOX KEY: UPLOAD (GLOBAL, 1 PRO USER / DEVICE)
    // ======================================================
    case "/e2e/inbox/upload": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const handle = session.handle;

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { jwk, deviceId, sigPub } = body;

        if (!jwk || typeof jwk !== "object") {
          return json(request, { error: "Missing jwk" }, 400);
        }

        if (
          typeof deviceId !== "string" ||
          deviceId.length < 8 ||
          deviceId.length > 64
        ) {
          return json(request, { error: "Missing deviceId" }, 400);
        }

        // GLOBAL Inbox-Key
        await env.RENEX_KV.put(
          `e2e:inbox:${handle}:${deviceId}`,
          JSON.stringify(jwk)
        );

        // Signing Public Key (optional — für Message-Signatur-Verifikation)
        if (sigPub && typeof sigPub === "object") {
          await env.RENEX_KV.put(
            `e2e:inbox:sigpub:${handle}:${deviceId}`,
            JSON.stringify(sigPub)
          );
        }

        // optional Index
        const idxKey = `e2e:inbox:index:${handle}`;
        let idx = [];
        const raw = await env.RENEX_KV.get(idxKey);
        if (raw) {
          try { idx = JSON.parse(raw) } catch {}
        }
        if (!idx.includes(deviceId)) idx.push(deviceId);

        // Max. 10 Geräte behalten — älteste entfernen
        const MAX_INBOX_DEVICES = 10;
        if (idx.length > MAX_INBOX_DEVICES) {
          const removed = idx.splice(0, idx.length - MAX_INBOX_DEVICES);
          for (const oldDeviceId of removed) {
            await env.RENEX_KV.delete(`e2e:inbox:${handle}:${oldDeviceId}`);
          }
        }

        await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

        // device_added → Authority-Kontakte benachrichtigen (CMK Rotation triggern)
        // Authority = alphabetisch kleinster Handle. Wir suchen Kontakte wo contact_handle < handle.
        try {
          const authContacts = await env.RENEX_DB.prepare(
            "SELECT contact_handle FROM contacts WHERE user_handle = ? AND status = 'accepted' AND contact_handle < ?"
          ).bind(handle, handle).all();

          for (const row of (authContacts.results || [])) {
            await pushToUserDO(env, row.contact_handle, {
              id: crypto.randomUUID(),
              type: "device_added",
              from: handle,
              to: row.contact_handle,
              ts: Date.now()
            });
          }
        } catch (e) {
          // non-fatal
          console.warn("device_added push fehlgeschlagen (non-fatal):", e.message);
        }

        // device_added → eigene Devices benachrichtigen
        // Damit das bestehende Device den CMK für das neue Device in KV ablegt
        try {
          await pushToUserDO(env, handle, {
            id: crypto.randomUUID(),
            type: "device_added",
            from: handle,
            to: handle,
            ts: Date.now()
          });
        } catch (e) {
          console.warn("device_added self-push fehlgeschlagen (non-fatal):", e.message);
        }

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // INBOX KEY: GET (PUBLIC, NO CONTACT REQUIRED)
    // ======================================================
    case "/e2e/inbox/get": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const { handle: me } = session;
        const user = (param(params, "user") || "").toLowerCase();

        if (!user || !/^[a-z0-9_]+$/.test(user)) {
          return json(request, { devices: [] });
        }

        // Rate Limit: max. 30 Inbox-Key-Abfragen pro Minute pro User
        const rlInbox = await rateLimit(env, `inbox_get:${me}`, 60_000, 30, { failOpen: true });
        if (!rlInbox) return json(request, { error: "Too many requests" }, 429);

        // Zugriffsprüfung: eigene Keys immer erlaubt
        // Fremde Keys: entweder Kontakt ODER gemeinsames Gruppen-Mitglied
        if (user !== me) {
          const isContact = await isAcceptedContact(env, me, user);
          if (!isContact) {
            // Fallback: gemeinsame Gruppe prüfen (JOIN über conversation_members)
            const sharedGroup = await env.RENEX_DB.prepare(`
              SELECT 1 FROM conversation_members cm1
              JOIN conversation_members cm2 ON cm1.convo_id = cm2.convo_id
              WHERE cm1.member_handle = ? AND cm2.member_handle = ?
              LIMIT 1
            `).bind(me, user).first();
            if (!sharedGroup) return json(request, { devices: [] });
          }
        }

        const idxKey = `e2e:inbox:index:${user}`;
        const rawIdx = await env.RENEX_KV.get(idxKey);

        let deviceIds = [];
        if (rawIdx) {
          try { deviceIds = JSON.parse(rawIdx); } catch {}
        }

        const devices = [];
        for (const deviceId of deviceIds) {
          const raw = await env.RENEX_KV.get(`e2e:inbox:${user}:${deviceId}`);
          if (!raw) continue;

          try {
            const entry = { deviceId, jwk: JSON.parse(raw) };
            // Signing Public Key mitsenden (falls vorhanden)
            const rawSig = await env.RENEX_KV.get(`e2e:inbox:sigpub:${user}:${deviceId}`);
            if (rawSig) {
              try { entry.sigPub = JSON.parse(rawSig); } catch {}
            }
            devices.push(entry);
          } catch {}
        }

        return json(request, { devices });
      }
      break;
    }

    // ======================================================
    // INBOX DEVICE REMOVE: Entfernt ein eigenes Device aus dem Inbox-Index
    // Triggert device_removed bei Authority-Kontakten → CMK Rotation (Forward Secrecy)
    // ======================================================
    case "/e2e/inbox/remove": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const handle = String(session.handle || "").toLowerCase();
        const body = await request.json().catch(() => ({}));
        const deviceId = String(body.deviceId || "").trim();

        if (!deviceId) return json(request, { error: "deviceId required" }, 400);

        // Device aus Inbox-Index entfernen
        const idxKey = `e2e:inbox:index:${handle}`;
        const rawIdx = await env.RENEX_KV.get(idxKey);
        let idx = [];
        if (rawIdx) { try { idx = JSON.parse(rawIdx); } catch {} }

        if (!idx.includes(deviceId)) {
          return json(request, { ok: true, removed: false, message: "Device not found" });
        }

        idx = idx.filter(id => id !== deviceId);
        await env.RENEX_KV.put(idxKey, JSON.stringify(idx));
        await env.RENEX_KV.delete(`e2e:inbox:${handle}:${deviceId}`);

        // device_removed → Authority-Kontakte benachrichtigen (CMK Rotation triggern)
        try {
          const authContacts = await env.RENEX_DB.prepare(
            "SELECT contact_handle FROM contacts WHERE user_handle = ? AND status = 'accepted' AND contact_handle < ?"
          ).bind(handle, handle).all();

          for (const row of (authContacts.results || [])) {
            await pushToUserDO(env, row.contact_handle, {
              id: crypto.randomUUID(),
              type: "device_removed",
              from: handle,
              to: row.contact_handle,
              ts: Date.now()
            });
          }
        } catch (e) {
          console.warn("device_removed push fehlgeschlagen (non-fatal):", e.message);
        }

        console.log(`🗑️ Device entfernt aus Inbox: ${handle} / ${deviceId} — ${idx.length} verbleiben`);
        return json(request, { ok: true, removed: true, remaining: idx.length });
      }
      break;
    }

    // ======================================================
    // CMK STORE: Authority speichert gewrappte CMK-Payloads in KV
    // ======================================================
    case "/e2e/cmk/store": {
      if (request.method === "POST") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { to, payloads } = body;

        if (!to || typeof to !== "string" || !/^[a-z0-9_]+$/.test(to)) {
          return json(request, { error: "Invalid to" }, 400);
        }
        if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 20) {
          return json(request, { error: "Invalid payloads" }, 400);
        }

        const peer = to.toLowerCase();
        const cid = [me, peer].sort().join(":");

        // Jedes Payload pro Device speichern
        const storedDeviceIds = [];
        for (const p of payloads) {
          if (
            typeof p.deviceId !== "string" || p.deviceId.length < 8 || p.deviceId.length > 64 ||
            typeof p.fromDeviceId !== "string" ||
            typeof p.ivB64 !== "string" ||
            typeof p.ctB64 !== "string"
          ) continue;

          await env.RENEX_KV.put(
            `e2e:cmk:${cid}:${p.deviceId}`,
            JSON.stringify({ fromDeviceId: p.fromDeviceId, ivB64: p.ivB64, ctB64: p.ctB64 })
          );
          storedDeviceIds.push(p.deviceId);
        }

        // Index für convoId
        const convoIdxKey = `e2e:cmk:index:${cid}`;
        let convoIdx = [];
        const rawConvoIdx = await env.RENEX_KV.get(convoIdxKey);
        if (rawConvoIdx) { try { convoIdx = JSON.parse(rawConvoIdx); } catch {} }
        for (const did of storedDeviceIds) {
          if (!convoIdx.includes(did)) convoIdx.push(did);
        }
        await env.RENEX_KV.put(convoIdxKey, JSON.stringify(convoIdx));

        // User-Index für account-delete cleanup
        for (const u of [me, peer]) {
          const userIdxKey = `e2e:cmk:user-idx:${u}`;
          let userIdx = [];
          const rawUserIdx = await env.RENEX_KV.get(userIdxKey);
          if (rawUserIdx) { try { userIdx = JSON.parse(rawUserIdx); } catch {} }
          if (!userIdx.includes(cid)) userIdx.push(cid);
          await env.RENEX_KV.put(userIdxKey, JSON.stringify(userIdx));
        }

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // CMK FETCH: Non-Authority holt gespeicherte CMK aus KV
    // ======================================================
    case "/e2e/cmk/fetch": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();
        const from = (param(params, "from") || "").toLowerCase();

        if (!from || !/^[a-z0-9_]+$/.test(from) || from === me) {
          return json(request, { payload: null });
        }

        const myDeviceId = (param(params, "deviceId") || "").trim();
        if (!myDeviceId || myDeviceId.length < 8 || myDeviceId.length > 64) {
          return json(request, { payload: null });
        }

        const cid = [me, from].sort().join(":");
        const raw = await env.RENEX_KV.get(`e2e:cmk:${cid}:${myDeviceId}`);
        if (!raw) return json(request, { payload: null });

        let payload = null;
        try { payload = JSON.parse(raw); } catch {}

        return json(request, { payload });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
