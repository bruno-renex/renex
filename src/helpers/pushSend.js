// ======================================================
// PUSH SEND — Web Push via @block65/webcrypto-web-push
// Bewährte Library für Cloudflare Workers.
// Abstrahiert über transport_type für spätere Erweiterung.
// ======================================================

import { buildPushPayload } from '@block65/webcrypto-web-push';

// ── WEB PUSH SENDEN ─────────────────────────────────────
// Strategie: Payload in KV speichern, Push mit Payload senden.
// Falls Encryption fehlschlägt → Fallback: leerer Push + SW holt Daten via API.
export async function sendWebPush(env, subscription, payloadObj) {
  const { endpoint, p256dh, auth_key, user_handle } = subscription;

  const vapid = {
    subject: env.VAPID_SUBJECT || "mailto:push@renex.id",
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const pushSubscription = {
    endpoint,
    expirationTime: null,
    keys: { p256dh, auth: auth_key },
  };

  // Payload in KV speichern (SW kann es als Fallback holen)
  const pushId = crypto.randomUUID();
  const handle = user_handle || "unknown";
  await env.RENEX_KV.put(
    `push_payload:${handle}:${pushId}`,
    JSON.stringify(payloadObj),
    { expirationTtl: 300 } // 5 Min TTL
  );

  try {
    // Versuch 1: Push MIT Payload (encrypted)
    const message = {
      data: JSON.stringify({ ...payloadObj, _pushId: pushId }),
      options: { ttl: 86400, urgency: "high" },
    };
    const payload = await buildPushPayload(message, pushSubscription, vapid);
    const res = await fetch(endpoint, payload);

    if (res.status === 410 || res.status === 404) {
      await env.RENEX_DB.prepare(
        "DELETE FROM push_subscriptions WHERE endpoint = ?"
      ).bind(endpoint).run();
      return { success: false, expired: true };
    }

    return { success: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    console.error(`🔔 Push encryption failed, trying empty push: ${err.message}`);

    // Versuch 2: Leerer Push (kein Payload, keine Encryption nötig)
    // SW feuert Push-Event mit data=null → holt Payload via API
    try {
      const emptyMessage = {
        data: "",
        options: { ttl: 86400, urgency: "high" },
      };
      const payload = await buildPushPayload(emptyMessage, pushSubscription, vapid);
      const res = await fetch(endpoint, payload);
      return { success: res.status >= 200 && res.status < 300, status: res.status, fallback: true };
    } catch (err2) {
      console.error(`🔔 Empty push also failed: ${err2.message}`);
      return { success: false, error: err2.message };
    }
  }
}

// ── MULTI-TRANSPORT PUSH DISPATCHER ─────────────────────
export async function dispatchPush(env, subscription, payload) {
  switch (subscription.transport_type) {
    case "web_push":
      return sendWebPush(env, subscription, payload);
    case "unified_push":
      console.log("UnifiedPush not yet implemented, skipping");
      return { success: false, reason: "not_implemented" };
    default:
      console.warn("Unknown transport_type:", subscription.transport_type);
      return { success: false, reason: "unknown_transport" };
  }
}

// ── PUSH AN ALLE SUBSCRIPTIONS EINES USERS ──────────────
export async function pushToUser(env, handle, payload) {
  const rows = await env.RENEX_DB.prepare(
    "SELECT endpoint, p256dh, auth_key, transport_type, user_handle FROM push_subscriptions WHERE user_handle = ?"
  ).bind(handle).all();

  const subs = rows.results || [];
  if (subs.length === 0) return;

  await Promise.allSettled(
    subs.map(sub => dispatchPush(env, sub, payload))
  );
}

// ── @MENTION DETECTION ──────────────────────────────────
export function detectMentions(messageText, groupMembers) {
  if (!messageText) return { mentionsAll: false, mentionedHandles: [] };

  const mentionsAll = /@everyone\b/i.test(messageText);
  const mentionedHandles = [];

  const mentionRegex = /@([a-z0-9_]+)/gi;
  let match;
  while ((match = mentionRegex.exec(messageText)) !== null) {
    const handle = match[1].toLowerCase();
    if (handle !== "everyone" && groupMembers.includes(handle)) {
      mentionedHandles.push(handle);
    }
  }

  return { mentionsAll, mentionedHandles };
}
