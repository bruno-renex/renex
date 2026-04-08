// /js/controlSocket.js
// Ersetzt controlPoller.js — WebSocket statt Long-Polling
// Gleiche processControlMessage Logik, gleiche BroadcastChannel Nutzung.

import { apiFetch } from "./api.js";
import { getDeviceId, idbGet, dmSessionId } from "./e2e.js";
import { isAuthority, ensureBootstrapped, receiveCMK, handleEpochRotate, rotateCMK, receiveCMKRotation } from "./sessionManager.js";
import { receiveGroupSK, distributeGroupSK, getOrCreateGroupSK } from "./groupSessionManager.js";

// ── State ────────────────────────────────────────────────
let ws = null;
let running = false;
let reconnectTimer = null;
let backoff = 1000;
const MAX_BACKOFF = 30000;

// Verhindert doppelte Verarbeitung — Map<id, seenAt> für age-based Eviction
// Kein .clear() — verhindert Replay-Angriff via ID-Recycling
const processedControlIds = new Map(); // id → timestamp (when we saw it)
const PROCESSED_IDS_MAX   = 2000;
const MAX_MSG_AGE_MS       = 60 * 1000;      // 60 Sekunden — ältere Nachrichten = Replay-Verdacht
const MAX_MSG_FUTURE_MS    = 60 * 1000;      // 1 Minute Toleranz für Clock-Skew

function markProcessed(id) {
  const now = Date.now();
  if (processedControlIds.size >= PROCESSED_IDS_MAX) {
    // Age-based Eviction: ältesten Eintrag nach Timestamp entfernen
    const cutoff = now - MAX_MSG_AGE_MS;
    let evicted = false;
    for (const [k, ts] of processedControlIds) {
      if (ts < cutoff) { processedControlIds.delete(k); evicted = true; break; }
    }
    // Fallback: FIFO wenn alle Einträge noch frisch (sollte nicht vorkommen)
    if (!evicted) processedControlIds.delete(processedControlIds.keys().next().value);
  }
  processedControlIds.set(id, now);
}

// Gibt true zurück wenn die Nachricht als Replay abgelehnt werden soll
function isReplay(m) {
  if (!m?.id) return true;
  if (processedControlIds.has(m.id)) return true;
  // Timestamp-Guard: zu alt oder zu weit in der Zukunft → Replay-Verdacht
  if (typeof m.ts === "number") {
    const delta = Date.now() - m.ts;
    if (delta > MAX_MSG_AGE_MS)     return true; // >5min alt
    if (delta < -MAX_MSG_FUTURE_MS) return true; // >1min in Zukunft
  }
  return false;
}

// ── BroadcastChannel + Session-Token (verhindert cross-tab Injection) ────
// Token wird einmalig pro Tab-Session generiert und in sessionStorage gespeichert.
// Empfänger (inbox.js, chat.js) im selben Tab prüfen den Token vor der Verarbeitung.
const bc = ("BroadcastChannel" in window)
  ? new BroadcastChannel("renex-control")
  : null;

const BC_TOKEN_KEY = "renex_bc_token";
function getBcToken() {
  let t = sessionStorage.getItem(BC_TOKEN_KEY);
  if (!t) { t = crypto.randomUUID(); sessionStorage.setItem(BC_TOKEN_KEY, t); }
  return t;
}
// Token sofort beim Laden generieren
getBcToken();

function notify(event) {
  if (bc) bc.postMessage({ ...event, _bcToken: getBcToken() });
  else localStorage.setItem("renex-control-event", JSON.stringify({ ...event, t: Date.now() }));
}

// ── Mute-Cache (60s TTL) ──────────────────────────────────
let _mutedSet     = new Set();
let _mutedLoaded  = 0;

async function isMuted(convoId) {
  const now = Date.now();
  if (now - _mutedLoaded > 60_000) {
    try {
      const res = await apiFetch("/notifications/muted");
      _mutedSet    = new Set(res.muted || []);
      _mutedLoaded = now;
    } catch {}
  }
  return _mutedSet.has(convoId);
}

// ── Helpers (1:1 aus controlPoller.js) ───────────────────
async function findSenderDeviceJwk(from, fromDeviceId) {
  const devices = (await idbGet(`peer-devices:${from}`)) || [];
  const d = devices.find(x => x.deviceId === fromDeviceId);
  return d?.jwk || null;
}

async function fetchInboxKeys(peerHandle) {
  const res = await apiFetch(`/e2e/inbox/get?user=${peerHandle}`);
  console.log("📮 CONTROL inbox fetch result:", res);
  if (Array.isArray(res.devices)) return res.devices;
  if (Array.isArray(res.keys)) return res.keys;
  return [];
}

// ── Control Message Processing (1:1 aus controlPoller.js) ─
async function processControlMessage(m) {
  console.log("📨 WS MESSAGE RECEIVED:", m.type ?? "chat", m);
  const me = localStorage.getItem("my_user");
  if (!me) return;

  // 1) CMK_REQ: wenn ich Leader → CMK senden
  if (m.type === "cmk_req") {
    const peer = m.from;
    if (!peer) return;

    console.log("⚖ CONTROL authority check:", { me, peer, authority: isAuthority(me, peer) });

    if (!isAuthority(me, peer)) return;

    sessionStorage.removeItem(`bootstrapped:${dmSessionId(me, peer)}`);
    await ensureBootstrapped(me, peer, fetchInboxKeys, apiFetch);
    return;
  }

  // 2) CMK: importieren
  if (m.type === "cmk" && Array.isArray(m.payloads)) {
    // Fallback: Sender-Key ggf. frisch aus Inbox laden (neues Device noch nicht im Cache)
    const findSenderJwkWithFallback = async (handle, deviceId) => {
      const cached = await findSenderDeviceJwk(handle, deviceId);
      if (cached) return cached;
      try {
        const devices = await fetchInboxKeys(handle);
        const d = (devices || []).find(d => d.deviceId === deviceId);
        return d?.jwk || null;
      } catch { return null; }
    };
    const ok = await receiveCMK({
      from: m.from,
      myDeviceId: getDeviceId(),
      payloads: m.payloads,
      findSenderDeviceJwk: findSenderJwkWithFallback
    });

    console.log("✅ receiveCMK result:", ok);

    if (ok) notify({ type: "CMK_READY", peer: m.from });
    return;
  }

  // 3) EPOCH ROTATE — nur von der Authority akzeptieren
  if (m.type === "epoch_rotate" && typeof m.rotationIndex === "number") {
    if (!isAuthority(m.from, me)) {
      console.warn("⚠️ epoch_rotate von Nicht-Authority ignoriert:", m.from);
      return;
    }
    const ok = await handleEpochRotate(me, m.from, m.rotationIndex);
    if (ok) notify({ type: "EPOCH_ROTATED", peer: m.from, rotationIndex: m.rotationIndex });
    return;
  }

  // 4) CMK ROTATE: Non-Authority empfängt neuen CMK — nur von Authority akzeptieren
  if (m.type === "cmk_rotate" && Array.isArray(m.payloads) && typeof m.fromRotationIndex === "number") {
    if (!isAuthority(m.from, me)) {
      console.warn("⚠️ cmk_rotate von Nicht-Authority ignoriert:", m.from);
      return;
    }
    const findSenderJwkWithFallback = async (handle, deviceId) => {
      const cached = await findSenderDeviceJwk(handle, deviceId);
      if (cached) return cached;
      try {
        const devices = await fetchInboxKeys(handle);
        const d = (devices || []).find(d => d.deviceId === deviceId);
        return d?.jwk || null;
      } catch { return null; }
    };
    const ok = await receiveCMKRotation({
      me,
      from: m.from,
      myDeviceId: getDeviceId(),
      fromRotationIndex: m.fromRotationIndex,
      payloads: m.payloads,
      findSenderDeviceJwkFn: findSenderJwkWithFallback
    });
    if (ok) notify({ type: "CMK_ROTATED", peer: m.from, fromRotationIndex: m.fromRotationIndex });
    return;
  }

  // 5) DEVICE ADDED: Authority soll CMK re-wrappen
  if (m.type === "device_added" && m.from) {
    if (isAuthority(me, m.from)) {
      // Peer-Device hinzugefügt → als Authority CMK re-wrappen
      console.log("🔑 Peer-Device hinzugefügt → CMK Re-wrap für:", m.from);
      notify({ type: "DEVICE_ADDED", peer: m.from });
    } else if (m.from === me) {
      // Eigenes neues Device hinzugefügt → CMK für alle Authority-Gespräche re-wrappen
      console.log("🔑 Eigenes neues Device hinzugefügt → DEVICE_ADDED_SELF");
      notify({ type: "DEVICE_ADDED_SELF" });
    }
    return;
  }

  // 6) DEVICE REMOVED: Authority soll CMK rotieren (Forward Secrecy)
  if (m.type === "device_removed" && m.from) {
    if (isAuthority(me, m.from)) {
      console.log("🔑 Peer-Device entfernt → CMK Rotation für:", m.from);
      notify({ type: "DEVICE_REMOVED", peer: m.from });
    }
    return;
  }

  // 7) AUTO-DELETE PROPOSAL/ACCEPT/DECLINE
  if (m.type === "auto_delete_set" && m.from && m.action) {
    console.log("🗑️ AUTO-DELETE event:", m.action, "von", m.from, "days:", m.days);
    notify({ type: "AUTO_DELETE_SET", peer: m.from, action: m.action, days: m.days ?? null, groupId: m.groupId ?? null });
    return;
  }

  // 8) DELIVERY EVENT
  if (m.type === "delivered") {
    console.log("📬 CONTROL delivered event:", m);
    notify({ type: "DELIVERED", from: m.from, sid: m.sid, ts: m.ts });
    return;
  }

  // 8b) MESSAGE DELETED
  if (m.type === "message_deleted" && m.messageId) {
    console.log("🗑️ Nachricht gelöscht:", m.messageId);
    notify({ type: "MESSAGE_DELETED", messageId: m.messageId, from: m.from });
    return;
  }

  // message_edited — Nachricht wurde bearbeitet
  if (m.type === "message_edited" && m.messageId) {
    notify({ type: "MESSAGE_EDITED", messageId: m.messageId, ciphertext: m.ciphertext, rotationIndex: m.rotationIndex, from: m.from, ts: m.ts });
    return;
  }

  // 9a) REACTION_UPDATED — Reaktion auf Nachricht hinzugefügt/entfernt
  if (m.type === "reaction_updated" && m.messageId) {
    notify({ type: "REACTION_UPDATED", messageId: m.messageId, reactions: m.reactions, convoId: m.convoId, from: m.from, action: m.action, emoji: m.emoji, msgAuthor: m.msgAuthor, groupName: m.groupName });
    return;
  }

  // 9) GROUP SENDER KEY — empfange GSK eines Gruppen-Members
  if (m.type === "gsk" && m.groupId && Array.isArray(m.payloads)) {
    console.log("🔑 GSK empfangen von:", m.from, "für Gruppe:", m.groupId);
    try {
      const ok = await receiveGroupSK({
        from: m.from,
        groupId: m.groupId,
        myDeviceId: getDeviceId(),
        payloads: m.payloads,
        findSenderDeviceJwkFn: async (handle, deviceId) => {
          const cached = await findSenderDeviceJwk(handle, deviceId);
          if (cached) return cached;
          try {
            const devices = await fetchInboxKeys(handle);
            const match = (devices || []).find(d => d.deviceId === deviceId);
            return match?.jwk || null;
          } catch (e) {
            console.warn("❌ GSK fetchInboxKeys fehlgeschlagen:", { handle, error: String(e) });
            return null;
          }
        }
      });
      if (ok) notify({ type: "GSK_READY", groupId: m.groupId, from: m.from });
    } catch (e) {
      console.warn("⚠️ receiveGroupSK fehlgeschlagen:", e);
    }
    return;
  }

  // 10) GROUP MEMBER JOINED
  if (m.type === "group_member_joined" && m.groupId) {
    console.log("👋 Gruppe:", m.groupId, "— neues Mitglied:", m.handle);
    notify({ type: "GROUP_MEMBER_JOINED", groupId: m.groupId, handle: m.handle, invitedBy: m.invitedBy });
    return;
  }

  // 10b) GUEST JOINED — Gast über Invite-Link beigetreten
  if (m.type === "guest_joined") {
    console.log("👤 Gast beigetreten:", m.handle, "Konversation:", m.groupId);
    notify({ type: "GUEST_JOINED", groupId: m.groupId, handle: m.handle, ts: m.ts });
    return;
  }

  // 11) GROUP RENAMED
  if (m.type === "group_renamed" && m.groupId) {
    console.log("✏️ Gruppe umbenannt:", m.groupId, "→", m.newName);
    notify({ type: "GROUP_RENAMED", groupId: m.groupId, newName: m.newName, renamedBy: m.renamedBy });
    return;
  }

  // 11b) GROUP MEMBER LEFT
  if (m.type === "group_member_left" && m.groupId) {
    console.log("🚪 Gruppe:", m.groupId, "— Mitglied verlassen:", m.handle);
    notify({ type: "GROUP_MEMBER_LEFT", groupId: m.groupId, handle: m.handle });
    return;
  }

  // 12) CONTACT ACCEPTED — meine Anfrage wurde angenommen
  if (m.type === "contact_accepted") {
    console.warn("🤝 Kontaktanfrage akzeptiert von:", m.from);
    notify({ type: "CONTACT_ACCEPTED", from: m.from });
    return;
  }

  // 12b) CONTACT UPDATE — stiller Reload (z.B. nach stiller Ablehnung)
  if (m.type === "contact_update") {
    notify({ type: "CONTACT_UPDATE" });
    return;
  }

  // 13) GROUP GSK REQUEST — jemand benötigt meinen GSK
  // Direkt in controlSocket antworten → funktioniert auch wenn Chat-Seite nicht offen ist
  if (m.type === "request_gsk" && m.groupId && m.requestedFrom) {
    if (m.requestedFrom === me && m.from && m.from !== me) {
      // Eigenen GSK sicherstellen + sofort an Anfrager senden
      (async () => {
        try {
          await getOrCreateGroupSK(m.groupId, me);
          const devices = await fetchInboxKeys(m.from);
          if (devices?.length) {
            const tagged = devices.map(d => ({ ...d, memberHandle: m.from }));
            await distributeGroupSK(m.groupId, me, tagged, apiFetch);
            console.log("✅ GSK auf Anfrage gesendet an:", m.from, "Gruppe:", m.groupId);
          }
        } catch (e) {
          console.warn("⚠️ REQUEST_GSK response fehlgeschlagen:", e);
        }
      })();
      // Zusätzlich BroadcastChannel für offene Chat-Seite (re-distribute via ensureGroupChatReady)
      notify({ type: "REQUEST_GSK", groupId: m.groupId, from: m.from });
    }
    return;
  }

  // 13) LIVE MESSAGE
  if (!m.type && m.from) {
    console.log("💬 LIVE MESSAGE:", m);
    // Convo-ID bestimmen (Gruppe = groupId, DM = alphabetisch sortiert)
    const liveMsgConvoId = m.groupId || (() => {
      const [a, b] = [me, m.from].sort();
      return `${a}:${b}`;
    })();
    const muted = await isMuted(liveMsgConvoId);
    notify({ type: "NEW_MESSAGE", message: m, muted });
    return;
  }
}

// ── WebSocket Verbindung ──────────────────────────────────
async function connect() {
  if (!running) return;

  const me = localStorage.getItem("my_user");
  if (!me) return;

  // WS-Ticket holen (60s TTL, Einmal-Verwendung)
  let wsUrl = `wss://api.renex.id/chat/ws`;
  try {
    const ticketRes = await apiFetch("/auth/ws-ticket", { method: "POST" });
    if (ticketRes?.ticket) {
      wsUrl = `wss://api.renex.id/chat/ws?ticket=${encodeURIComponent(ticketRes.ticket)}`;
    }
  } catch (e) {
    // 401 / Session expired → apiFetch redirectet bereits zur Login-Seite
    // Reconnect-Loop stoppen damit kein Endlos-Redirect entsteht
    if (e?.message?.includes("Session expired") || e?.message?.includes("401")) {
      running = false;
      return;
    }
    // andere Fehler (Netzwerk etc.) → Fallback auf Cookie-Auth
  }

  console.log("🔌 Control WebSocket connecting...");

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("WebSocket init failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("🟢 Control WebSocket connected");
    backoff = 1000; // Reset bei Erfolg
    window.dispatchEvent(new CustomEvent("renex-ws-state", { detail: { connected: true } }));
  };

  ws.onmessage = async (event) => {
    try {
      const m = JSON.parse(event.data);

      // Doppel-Processing + Replay-Schutz (ID-Dedup + Timestamp-Guard)
      if (isReplay(m)) return;
      markProcessed(m.id);

      await processControlMessage(m);
    } catch (e) {
      console.warn("⚠️ WS message error:", e);
    }
  };

  ws.onclose = (event) => {
    ws = null;
    console.log(`🔴 Control WebSocket closed (code: ${event.code})`);
    window.dispatchEvent(new CustomEvent("renex-ws-state", { detail: { connected: false } }));

    // 1000 = Normal close, 1001 = Tab/Page close → kein Reconnect
    if (!running || event.code === 1000) return;

    // 4401 = Auth-Fehler vom Server (Session ungültig) → zur Login-Seite
    if (event.code === 4401) {
      running = false;
      localStorage.removeItem("my_user");
      window.location.replace("/index.html");
      return;
    }

    // Alle anderen Codes (1006 = Netzwerkfehler, 1011 = Server-Error…) → Reconnect
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose wird danach automatisch aufgerufen
    console.warn("⚠️ Control WebSocket error");
  };
}

function scheduleReconnect() {
  if (!running) return;
  console.log(`🔄 Reconnect in ${backoff}ms`);
  reconnectTimer = setTimeout(() => {
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    connect();
  }, backoff);
}

// ── Public API (gleiche Namen wie controlPoller.js) ───────
export function isWSConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function startGlobalControlPolling() {
  if (running) return;
  running = true;
  console.log("🌍 GlobalControl WebSocket gestartet");
  connect();
}

export function stopGlobalControlPolling() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.close(1000, "App stopped");
    ws = null;
  }
}
