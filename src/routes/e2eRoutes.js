import { json, readJson, param, isUUID } from '../utils.js';
import { requireSession, requireAnySession, rateLimit, isAcceptedContact, pushToUserDO } from '../auth.js';

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
        const session = await requireAnySession(request, env);
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
        const session = await requireAnySession(request, env);
        if (!session) {
          return json(request, { error: "Not authenticated" }, 401);
        }

        const handle = session.handle;

        // Rate-Limit (Spec §6: 5/min/User)
        const rl = await rateLimit(env, `inbox_upload:${handle}`, 60_000, 5);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { jwk, deviceId, sigPub, name } = body;

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

        // Device-Limit gegen D1 prüfen (Spec §6)
        // Pro-Tier: forward-compatible. Heute existiert kein tier-Field → immer free → MAX=5.
        const isPro = session.tier === 'pro';
        const MAX_DEVICES = isPro ? 10 : 5;

        const existingRows = await env.RENEX_DB.prepare(
          "SELECT device_id FROM devices WHERE user_handle = ? AND state IN ('active','syncing','new')"
        ).bind(handle).all();
        const existingIds = (existingRows.results || []).map(r => r.device_id);
        const isExistingDevice = existingIds.includes(deviceId);

        if (!isExistingDevice && existingIds.length >= MAX_DEVICES) {
          return json(request, {
            error: "device_limit_reached",
            currentDevices: existingIds.length,
            maxDevices: MAX_DEVICES,
            upgradeAvailable: !isPro
          }, 409);
        }

        // D1-Upsert: Source-of-Truth für Device-State
        const now = Date.now();
        const safeName = (typeof name === "string") ? name.slice(0, 64) : null;
        const ua = request.headers.get('user-agent')?.slice(0, 256) || null;

        await env.RENEX_DB.prepare(`
          INSERT INTO devices (device_id, user_handle, state, name, user_agent, created_at, last_seen_at)
          VALUES (?, ?, 'new', ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            name = COALESCE(excluded.name, devices.name),
            -- Revoked → 'new' resetten, damit Re-Registrierung funktioniert.
            -- Active/syncing bleiben unverändert (kein Downgrade).
            state = CASE WHEN devices.state = 'revoked' THEN 'new' ELSE devices.state END,
            -- Revoke-Felder zurücksetzen wenn re-registriert
            revoked_at = CASE WHEN devices.state = 'revoked' THEN NULL ELSE devices.revoked_at END,
            revoked_by = CASE WHEN devices.state = 'revoked' THEN NULL ELSE devices.revoked_by END
        `).bind(deviceId, handle, safeName, ua, now, now).run();

        // GLOBAL Inbox-Key (KV Hot-Cache)
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

        // State 'new' → 'syncing' nach erfolgreichem KV-Write
        await env.RENEX_DB.prepare(
          "UPDATE devices SET state = 'syncing' WHERE device_id = ? AND state = 'new'"
        ).bind(deviceId).run();

        // KV-Index aus D1 ableiten (KV ist Cache)
        const activeRows = await env.RENEX_DB.prepare(
          "SELECT device_id FROM devices WHERE user_handle = ? AND state IN ('active','syncing') ORDER BY created_at"
        ).bind(handle).all();
        const idx = (activeRows.results || []).map(r => r.device_id);
        const idxKey = `e2e:inbox:index:${handle}`;
        await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

        // device_added: Push an Kontakte + eigene Devices.
        // WICHTIG: deviceId + jwk + sigPub IM PUSH mitliefern.
        // Grund: KV ist eventually consistent — Empfänger der fetchPeerDevices()
        // ruft, könnte alten Index ohne neuen Device sehen. Mit Push-Daten kann
        // Frontend retry-bis-deviceId-im-fetch-list machen.
        const pushPayload = {
          type: "device_added",
          from: handle,
          deviceId,
          jwk,
          sigPub: sigPub || null,
          ts: Date.now(),
        };

        try {
          const authContacts = await env.RENEX_DB.prepare(
            "SELECT contact_handle FROM contacts WHERE user_handle = ? AND status = 'accepted' AND contact_handle < ?"
          ).bind(handle, handle).all();

          for (const row of (authContacts.results || [])) {
            await pushToUserDO(env, row.contact_handle, {
              ...pushPayload,
              id: crypto.randomUUID(),
              to: row.contact_handle,
            });
          }
        } catch (e) {
          console.warn("device_added push fehlgeschlagen (non-fatal):", e.message);
        }

        // Self-Push: eigene anderen Devices benachrichtigen
        try {
          await pushToUserDO(env, handle, {
            ...pushPayload,
            id: crypto.randomUUID(),
            to: handle,
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
        const session = await requireAnySession(request, env);
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

        const deviceEntries = await Promise.all(
          deviceIds.map(async (deviceId) => {
            const [raw, rawSig] = await Promise.all([
              env.RENEX_KV.get(`e2e:inbox:${user}:${deviceId}`),
              env.RENEX_KV.get(`e2e:inbox:sigpub:${user}:${deviceId}`),
            ]);
            if (!raw) return null;
            try {
              const entry = { deviceId, jwk: JSON.parse(raw) };
              if (rawSig) {
                try { entry.sigPub = JSON.parse(rawSig); } catch {}
              }
              return entry;
            } catch { return null; }
          })
        );
        const devices = deviceEntries.filter(Boolean);

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

        // Rate-Limit (Spec §6: 10/min/User, Anti-Mass-Revoke-DoS)
        const rl = await rateLimit(env, `inbox_remove:${handle}`, 60_000, 10);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await request.json().catch(() => ({}));
        const deviceId = String(body.deviceId || "").trim();
        // reason: 'user' (Sicherheits-Aktion → CMK-Rotation) | 'self' (Logout-Cleanup → keine Rotation)
        const reason = body.reason === 'self' ? 'self' : 'user';

        if (!deviceId) return json(request, { error: "deviceId required" }, 400);

        // D1: state='revoked' setzen (Source-of-Truth)
        const now = Date.now();
        const updateResult = await env.RENEX_DB.prepare(`
          UPDATE devices
          SET state = 'revoked', revoked_at = ?, revoked_by = ?
          WHERE device_id = ? AND user_handle = ? AND state != 'revoked'
        `).bind(now, reason, deviceId, handle).run();

        if ((updateResult.meta?.changes ?? 0) === 0) {
          return json(request, { ok: true, removed: false, message: "Device not found or already revoked" });
        }

        // KV-Cleanup: Crypto-Material löschen
        await env.RENEX_KV.delete(`e2e:inbox:${handle}:${deviceId}`);
        await env.RENEX_KV.delete(`e2e:inbox:sigpub:${handle}:${deviceId}`);

        // KV-Index neu aus D1 ableiten
        const remainingRows = await env.RENEX_DB.prepare(
          "SELECT device_id FROM devices WHERE user_handle = ? AND state IN ('active','syncing') ORDER BY created_at"
        ).bind(handle).all();
        const remaining = (remainingRows.results || []).map(r => r.device_id);
        await env.RENEX_KV.put(`e2e:inbox:index:${handle}`, JSON.stringify(remaining));

        // device_removed-Push NUR bei reason='user' (Sicherheits-Aktion → CMK-Rotation)
        // 'self' = Logout-Cleanup, Device ist nicht kompromittiert → keine Rotation nötig.
        if (reason === 'user') {
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
                deviceId,
                reason: 'user',
                ts: now
              });
            }
          } catch (e) {
            console.warn("device_removed push fehlgeschlagen (non-fatal):", e.message);
          }
        }

        // Self-Push immer (eigene Devices müssen die Liste refreshen)
        try {
          await pushToUserDO(env, handle, {
            id: crypto.randomUUID(),
            type: "device_removed",
            from: handle,
            to: handle,
            deviceId,
            reason,
            ts: now
          });
        } catch (e) {
          console.warn("device_removed self-push fehlgeschlagen (non-fatal):", e.message);
        }

        console.log(`🗑️ Device entfernt: ${handle} / ${deviceId} (reason=${reason}) — ${remaining.length} verbleiben`);
        return json(request, { ok: true, removed: true, remaining: remaining.length, reason });
      }
      break;
    }

    // ======================================================
    // CMK STORE: Authority speichert gewrappte CMK-Payloads in KV
    // ======================================================
    case "/e2e/cmk/store": {
      if (request.method === "POST") {
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();

        // Rate-Limit (Spec §6: 60/min/User, CMK-Spam verhindern)
        const rl = await rateLimit(env, `cmk_store:${me}`, 60_000, 60);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

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
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();

        const rl = await rateLimit(env, `cmk_fetch:${me}`, 60_000, 30);
        if (!rl) return json(request, { error: "Too many requests" }, 429);
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

    // ======================================================
    // Phase 5.3: GROUP-GSK STORE — eigener GSK in KV für eigene Devices
    // ======================================================
    case "/e2e/group-gsk/store": {
      if (request.method === "POST") {
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();
        const rl = await rateLimit(env, `group_gsk_store:${me}`, 60_000, 30);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const body = await readJson(request);
        if (!body) return json(request, { error: "Invalid JSON" }, 400);

        const { groupId, payloads } = body;
        if (!groupId || typeof groupId !== "string" || groupId.length > 64) {
          return json(request, { error: "Invalid groupId" }, 400);
        }
        if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 20) {
          return json(request, { error: "Invalid payloads" }, 400);
        }

        // Membership-Check: nur Mitglieder dürfen für ihre Gruppe Daten ablegen
        const memberRow = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ? LIMIT 1"
        ).bind(groupId, me).first();
        if (!memberRow) return json(request, { error: "Not a group member" }, 403);

        const storedDeviceIds = [];
        for (const p of payloads) {
          if (
            typeof p.deviceId !== "string" || p.deviceId.length < 8 || p.deviceId.length > 64 ||
            typeof p.fromDeviceId !== "string" ||
            typeof p.ivB64 !== "string" ||
            typeof p.ctB64 !== "string"
          ) continue;

          await env.RENEX_KV.put(
            `e2e:gsk:${groupId}:${me}:${p.deviceId}`,
            JSON.stringify({ fromDeviceId: p.fromDeviceId, ivB64: p.ivB64, ctB64: p.ctB64 })
          );
          storedDeviceIds.push(p.deviceId);
        }

        // Index für späteres Cleanup (bei group-leave / user-delete)
        const idxKey = `e2e:gsk:index:${groupId}:${me}`;
        let idx = [];
        const rawIdx = await env.RENEX_KV.get(idxKey);
        if (rawIdx) { try { idx = JSON.parse(rawIdx); } catch {} }
        for (const did of storedDeviceIds) {
          if (!idx.includes(did)) idx.push(did);
        }
        await env.RENEX_KV.put(idxKey, JSON.stringify(idx));

        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // Phase 5.3: GROUP-GSK FETCH — neues Device holt eigenen GSK aus KV
    // ======================================================
    case "/e2e/group-gsk/fetch": {
      if (request.method === "GET") {
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const me = String(session.handle || "").toLowerCase();
        const rl = await rateLimit(env, `group_gsk_fetch:${me}`, 60_000, 60);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const groupId = (param(params, "groupId") || "").trim();
        const deviceId = (param(params, "deviceId") || "").trim();
        if (!groupId || groupId.length > 64) return json(request, { payload: null });
        if (!deviceId || deviceId.length < 8 || deviceId.length > 64) return json(request, { payload: null });

        // Membership-Check
        const memberRow = await env.RENEX_DB.prepare(
          "SELECT 1 FROM conversation_members WHERE convo_id = ? AND member_handle = ? LIMIT 1"
        ).bind(groupId, me).first();
        if (!memberRow) return json(request, { payload: null });

        const raw = await env.RENEX_KV.get(`e2e:gsk:${groupId}:${me}:${deviceId}`);
        if (!raw) return json(request, { payload: null });

        let payload = null;
        try { payload = JSON.parse(raw); } catch {}
        return json(request, { payload });
      }
      break;
    }

    // ======================================================
    // INBOX HEARTBEAT: state-Transition syncing→active + last_seen
    // Debounced 1×/Stunde via KV-Cache.
    // Spec: docs/MULTI_DEVICE.md §3, §6 (Δ3)
    // ======================================================
    case "/e2e/inbox/heartbeat": {
      if (request.method === "POST") {
        const session = await requireAnySession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const handle = String(session.handle || "").toLowerCase();

        const body = await readJson(request);
        const deviceId = String(body?.deviceId || "").trim();
        if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
          return json(request, { error: "deviceId required" }, 400);
        }

        // Rate-Limit pro Device (statt pro User), damit Multi-Tab/Multi-Device-Szenarien
        // sich nicht gegenseitig rate-limiten. Generös: 12/min/Device — Backend hat
        // ohnehin ein 1h-Debounce, mehr als 1 echtes Update pro Stunde passiert nicht.
        const rl = await rateLimit(env, `heartbeat:${handle}:${deviceId}`, 60_000, 12);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        // Debounce: nur 1×/Stunde tatsächlich D1 schreiben
        const cacheKey = `heartbeat:${handle}:${deviceId}`;
        const last = await env.RENEX_KV.get(cacheKey);
        const now = Date.now();
        if (last && (now - parseInt(last, 10)) < 3600_000) {
          return json(request, { ok: true, debounced: true });
        }

        const result = await env.RENEX_DB.prepare(`
          UPDATE devices
          SET last_seen_at = ?,
              state = CASE WHEN state = 'syncing' THEN 'active' ELSE state END
          WHERE device_id = ? AND user_handle = ? AND state IN ('active','syncing')
        `).bind(now, deviceId, handle).run();

        if ((result.meta?.changes ?? 0) === 0) {
          return json(request, { error: "Device not found or revoked" }, 404);
        }

        await env.RENEX_KV.put(cacheKey, String(now), { expirationTtl: 7200 });
        return json(request, { ok: true });
      }
      break;
    }

    // ======================================================
    // DEVICES LIST: Settings-UI — eigene aktive Devices
    // Spec: docs/MULTI_DEVICE.md §10, §12 (Δ4)
    // ======================================================
    case "/e2e/devices/list": {
      if (request.method === "GET") {
        const session = await requireSession(request, env);
        if (!session) return json(request, { error: "Not authenticated" }, 401);

        const handle = String(session.handle || "").toLowerCase();

        // Rate-Limit (Spec §6: 30/min/User)
        const rl = await rateLimit(env, `devices_list:${handle}`, 60_000, 30);
        if (!rl) return json(request, { error: "Too many requests" }, 429);

        const rows = await env.RENEX_DB.prepare(`
          SELECT device_id, state, name, user_agent, created_at, last_seen_at, revoked_at, revoked_by
          FROM devices
          WHERE user_handle = ? AND state != 'revoked'
          ORDER BY last_seen_at DESC
        `).bind(handle).all();

        // Pro-Tier-Limit forward-compatible (siehe Δ1)
        const isPro = session.tier === 'pro';
        const maxDevices = isPro ? 10 : 5;

        const devices = (rows.results || []).map(r => ({
          deviceId: r.device_id,
          state: r.state,
          name: r.name,
          userAgent: r.user_agent,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
        }));

        const currentDeviceId = param(params, "current") || null;

        return json(request, {
          devices,
          currentDeviceId,
          maxDevices,
          tier: isPro ? 'pro' : 'free'
        });
      }
      break;
    }

    default:
      break;
  }

  return json(request, { error: "Not found" }, 404);
}
