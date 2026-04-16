// ======================================================
// RENEX Service Worker — Push Notifications + Badge
// ======================================================

const API_BASE = "https://api.renex.id";

// ── PUSH EVENT ──────────────────────────────────────────
// Empfängt Web-Push vom Backend, zeigt Notification an.
// Payload kann encrypted (JSON) oder leer sein (Fallback → API fetch).
self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload;

  // Versuch 1: Payload aus Push-Event (encrypted)
  try {
    const text = event.data?.text();
    if (text && text.length > 2) {
      payload = JSON.parse(text);
    }
  } catch {}

  // Fallback: Default-Notification wenn keine Payload
  if (!payload) {
    payload = { title: "RENEX", body: "Neue Nachricht" };
  }

  const { title, body, tag, icon, data, badge } = payload;

  const options = {
    body: body || "",
    tag: tag || "renex-default",
    icon: icon || "/icons/icon-192.png",
    badge: badge || "/icons/icon-192.png",
    renotify: true,
    data: data || {},
    vibrate: [100, 50, 100],
    actions: [],
  };

  if (data?.type === "message") {
    options.actions = [
      { action: "reply", title: "Antworten", type: "text", placeholder: "Nachricht..." },
      { action: "mark_read", title: "Gelesen" },
      { action: "mute_1h", title: "Mute 1h" },
    ];
  }

  // App-Icon Badge
  try {
    if (navigator.setAppBadge) {
      // Chromium: setAppBadge mit inkrementierendem Count
      const cache = await caches.open("renex-badge");
      const resp = await cache.match("badge-count").catch(() => null);
      let count = resp ? parseInt(await resp.text()) || 0 : 0;
      count++;
      await cache.put("badge-count", new Response(String(count)));
      navigator.setAppBadge(count).catch(() => {});
    }
  } catch {}


  try {
    await self.registration.showNotification(title || "RENEX", options);
  } catch (err) {
    console.warn("Push: notification blocked", err.message);
  }
}

// ── NOTIFICATION CLICK ──────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const action = event.action;

  // Alle Actions in try/catch wrappen — ein Fehler darf den SW NICHT crashen
  if (action === "reply" && event.reply) {
    event.waitUntil(handleReply(data, event.reply).catch(e => console.warn("SW: reply error", e.message)));
    return;
  }

  if (action === "mark_read") {
    event.waitUntil(handleMarkRead(data).catch(e => console.warn("SW: mark_read error", e.message)));
    return;
  }

  if (action === "mute_1h") {
    event.waitUntil(handleMute(data, 60).catch(e => console.warn("SW: mute error", e.message)));
    return;
  }

  // Default: App öffnen / fokussieren
  const targetUrl = data.url || "/inbox.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // Bereits offenen Tab fokussieren
      for (const client of windowClients) {
        try {
          if (new URL(client.url).pathname.startsWith("/inbox") || new URL(client.url).pathname.startsWith("/chat")) {
            return client.focus().then(() => {
              client.postMessage({ type: "navigate", url: targetUrl });
            });
          }
        } catch (e) {
          console.warn("SW: focus failed", e.message);
        }
      }
      // Kein offener Tab → neuen öffnen
      return clients.openWindow(targetUrl).catch((e) => {
        console.warn("SW: openWindow failed", e.message);
      });
    }).catch((e) => {
      console.warn("SW: notificationclick error", e.message);
    })
  );
});

// ── NOTIFICATION CLOSE (Dismiss) ────────────────────────
self.addEventListener("notificationclose", (event) => {
  // Badge aktualisieren wenn alle Notifications geschlossen
  // (Optional: könnte Badge-Count via API refreshen)
});

// ── INLINE REPLY HANDLER ────────────────────────────────
async function handleReply(data, replyText) {
  if (!replyText || !data.convoId || !data.from) return;

  // Hinweis: Inline-Reply geht nur unverschlüsselt (kein E2E im SW möglich)
  // Für E2E-Chats → App öffnen
  if (data.e2e) {
    const targetUrl = data.url || "/inbox.html";
    const windowClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      client.focus();
      client.postMessage({ type: "navigate", url: targetUrl });
      return;
    }
    await clients.openWindow(targetUrl);
    return;
  }

  // Plaintext-Reply via API
  try {
    await fetch(`${API_BASE}/chat/send`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: data.from,
        message: replyText,
      }),
    });
  } catch (err) {
    console.error("SW: reply failed", err);
  }
}

// ── MARK READ HANDLER ───────────────────────────────────
async function handleMarkRead(data) {
  if (!data.from) return;
  try {
    await fetch(`${API_BASE}/chat/delivered`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ with: data.from }),
    });
    // Badge zurücksetzen
    if (navigator.clearAppBadge) {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch (err) {
    console.error("SW: mark_read failed", err);
  }
}

// ── MUTE HANDLER (Discord-Style: 1h Mute aus Notification) ──
async function handleMute(data, durationMinutes) {
  if (!data.convoId) return;
  try {
    await fetch(`${API_BASE}/notifications/mute`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convoId: data.convoId,
        level: "all",
        duration: durationMinutes,
      }),
    });
  } catch (err) {
    console.error("SW: mute failed", err);
  }
}

// ── INSTALL / ACTIVATE ──────────────────────────────────
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

// ── MESSAGE HANDLER (von Frontend) ──────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_BADGE") {
    const count = event.data.count || 0;
    // Badge-Cache synchronisieren
    caches.open("renex-badge").then(c => c.put("badge-count", new Response(String(count)))).catch(() => {});
    if (count > 0 && navigator.setAppBadge) {
      navigator.setAppBadge(count).catch(() => {});
    } else if (navigator.clearAppBadge) {
      navigator.clearAppBadge().catch(() => {});
    }
  }
});
