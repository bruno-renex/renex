import { pushToUserDO } from './auth.js';

// ======================================================
// CRON: Automatische Nachrichten-Löschung (stündlich)
// Schedule: "0 * * * *" — siehe wrangler.toml
// Auto-Delete Hard-Cleanup läuft stündlich für minimale Server-Lebensdauer.
// Andere Cleanups (Feedback, Push, Guests, Devices) laufen mit, sind aber
// idempotent → kein Problem bei stündlicher Frequenz.
// ======================================================
export async function scheduled(event, env) {
  console.log("🕐 Auto-Delete Cron gestartet:", new Date().toISOString());

  try {
    let deleted = 0;

    // Conversation-Level Auto-Delete (beide haben akzeptiert)
    const activeConvos = await env.RENEX_DB.prepare(
      "SELECT convo_id, days FROM auto_delete_settings WHERE status = 'active'"
    ).all();

    for (const row of (activeConvos.results ?? [])) {
      try {
        const cutoffTs = Date.now() - row.days * 86400_000;

        // R2-Objekte VOR D1-Delete löschen (GIFs haben keinen R2-Key)
        if (env.RENEX_FILES) {
          const attachments = await env.RENEX_DB.prepare(
            "SELECT attachment_key FROM messages WHERE convo_id = ? AND ts < ? AND type IS NULL AND attachment_key IS NOT NULL AND attachment_type != 'gif'"
          ).bind(row.convo_id, cutoffTs).all();
          for (const a of (attachments.results ?? [])) {
            if (a.attachment_key) {
              await env.RENEX_FILES.delete(a.attachment_key).catch(() => {});
            }
          }
        }

        const result = await env.RENEX_DB.prepare(
          "DELETE FROM messages WHERE convo_id = ? AND ts < ? AND type IS NULL"
        ).bind(row.convo_id, cutoffTs).run();
        const count = result.meta?.changes ?? 0;
        if (count > 0) {
          console.log(`🗑️ Auto-Delete Convo: ${count} Nachrichten gelöscht für ${row.convo_id} (>${row.days}d)`);
          deleted += count;
        }
      } catch (e) {
        console.warn("Auto-Delete Convo Fehler:", row.convo_id, e.message);
      }
    }

    console.log(`✅ Auto-Delete Cron abgeschlossen: ${deleted} Nachrichten gelöscht`);
  } catch (e) {
    console.error("❌ Auto-Delete Cron fehlgeschlagen:", e);
  }

  // ── Feedback älter als 30 Tage löschen (DSGVO) ──────────────────────
  try {
    const feedbackCutoff = Date.now() - 30 * 86400_000;
    const fbResult = await env.RENEX_DB.prepare(
      "DELETE FROM feedback WHERE created_at < ?"
    ).bind(feedbackCutoff).run();
    const fbDeleted = fbResult.meta?.changes ?? 0;
    if (fbDeleted > 0) {
      console.log(`🗑️ Feedback-Cleanup: ${fbDeleted} Einträge älter als 30 Tage gelöscht`);
    }
  } catch (e) {
    console.error("❌ Feedback-Cleanup fehlgeschlagen:", e);
  }

  // ── Push-Subscriptions aufräumen (>30 Tage nicht aktualisiert) ───────
  try {
    const pushCutoff = Date.now() - 30 * 86400_000;
    const pushResult = await env.RENEX_DB.prepare(
      "DELETE FROM push_subscriptions WHERE updated_at < ?"
    ).bind(pushCutoff).run();
    const pushDeleted = pushResult.meta?.changes ?? 0;
    if (pushDeleted > 0) {
      console.log(`🔔 Push-Cleanup: ${pushDeleted} verwaiste Subscriptions gelöscht (>30 Tage)`);
    }
  } catch (e) {
    console.error("❌ Push-Cleanup fehlgeschlagen:", e);
  }

  // ── Abgelaufene Gast-Mitgliedschaften aufräumen ──────────────────────
  try {
    const now = Date.now();

    // Alle abgelaufenen (und nicht konvertierten) Guest-Sessions mit Handle + ConvoId
    const expiredGuests = await env.RENEX_DB.prepare(
      `SELECT guest_handle, convo_id FROM guest_sessions
       WHERE expires_at < ? AND converted_to IS NULL AND guest_handle != ''`
    ).bind(now).all();

    let removedMembers = 0;
    for (const g of (expiredGuests.results ?? [])) {
      if (!g.guest_handle || !g.convo_id) continue;
      const result = await env.RENEX_DB.prepare(
        "DELETE FROM conversation_members WHERE convo_id = ? AND member_handle = ? AND role = 'guest'"
      ).bind(g.convo_id, g.guest_handle).run();
      removedMembers += result.meta?.changes ?? 0;
    }

    // Kontakt-Einträge abgelaufener Gäste auf 'removed' setzen
    let removedContacts = 0;
    for (const g of (expiredGuests.results ?? [])) {
      if (!g.guest_handle) continue;
      // Beide Richtungen: Gast→Einlader und Einlader→Gast
      const r1 = await env.RENEX_DB.prepare(
        "UPDATE contacts SET status = 'removed', updated_at = ? WHERE contact_handle = ? AND status = 'accepted'"
      ).bind(now, g.guest_handle).run();
      const r2 = await env.RENEX_DB.prepare(
        "UPDATE contacts SET status = 'removed', updated_at = ? WHERE user_handle = ? AND status = 'accepted'"
      ).bind(now, g.guest_handle).run();
      removedContacts += (r1.meta?.changes ?? 0) + (r2.meta?.changes ?? 0);
    }

    if (removedMembers > 0 || removedContacts > 0) {
      console.log(`🧹 Guest-Cleanup: ${removedMembers} Mitgliedschaften, ${removedContacts} Kontakte entfernt`);
    }
  } catch (e) {
    console.error("❌ Guest-Cleanup Cron fehlgeschlagen:", e);
  }

  // ======================================================
  // Multi-Device Cron-Sweeps (Phase 1B.1)
  // Spec: docs/MULTI_DEVICE.md §3, §6, §7.4 (Δ6)
  // ======================================================

  // ── Stuck-Syncing-Cleanup (24h) ──────────────────────
  // Devices, die >24h in 'new' oder 'syncing' hängen → 'revoked' (auto).
  try {
    const cutoff = Date.now() - 86400_000;
    const result = await env.RENEX_DB.prepare(`
      UPDATE devices
      SET state = 'revoked', revoked_at = ?, revoked_by = 'auto'
      WHERE state IN ('new','syncing') AND created_at < ?
    `).bind(Date.now(), cutoff).run();
    const changes = result.meta?.changes ?? 0;
    if (changes > 0) {
      console.log(`🧹 Stuck-Syncing-Cleanup: ${changes} Devices`);
    }
  } catch (e) {
    console.error("❌ Stuck-Syncing-Cleanup fehlgeschlagen:", e);
  }

  // ── Auto-Revoke (30d Inaktivität) ────────────────────
  await runAutoRevokeStaleDevices(env);

  // ── Revoked-Row-Retention (90d) ──────────────────────
  await _revokedRetention(env);
}

// ======================================================
// Auto-Revoke: Devices mit >30d Inaktivität auf 'revoked' setzen.
// KEINE CMK-Rotation (revoked_by='auto') — Spec: docs/MULTI_DEVICE.md §3.2.
// Nur Self-Push damit eigene andere Devices ihre Liste refreshen.
//
// Exportiert für Unit-Tests (siehe tests/cronAutoRevoke.test.js).
// @returns {Promise<{revoked: number, errors: number}>}
// ======================================================
export async function runAutoRevokeStaleDevices(env, opts = {}) {
  const inactivityMs = opts.inactivityMs ?? 30 * 86400_000;
  let revokedCount = 0;
  let errorCount = 0;

  try {
    const cutoff = Date.now() - inactivityMs;
    const stale = await env.RENEX_DB.prepare(`
      SELECT device_id, user_handle FROM devices
      WHERE state = 'active' AND last_seen_at < ?
    `).bind(cutoff).all();

    const staleRows = stale.results || [];
    for (const row of staleRows) {
      try {
        await env.RENEX_DB.prepare(`
          UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = 'auto'
          WHERE device_id = ?
        `).bind(Date.now(), row.device_id).run();

        await env.RENEX_KV.delete(`e2e:inbox:${row.user_handle}:${row.device_id}`);
        await env.RENEX_KV.delete(`e2e:inbox:sigpub:${row.user_handle}:${row.device_id}`);

        // KV-Index aus D1 neu ableiten
        const remaining = await env.RENEX_DB.prepare(
          "SELECT device_id FROM devices WHERE user_handle = ? AND state IN ('active','syncing') ORDER BY created_at"
        ).bind(row.user_handle).all();
        await env.RENEX_KV.put(
          `e2e:inbox:index:${row.user_handle}`,
          JSON.stringify((remaining.results || []).map(r => r.device_id))
        );

        // Self-DO-Push (NUR self — keine Authority-Pushes, keine Rotation)
        await pushToUserDO(env, row.user_handle, {
          id: crypto.randomUUID(),
          type: "device_removed",
          from: row.user_handle,
          to: row.user_handle,
          deviceId: row.device_id,
          reason: "auto",
          ts: Date.now()
        }).catch(() => {});

        revokedCount++;
      } catch (e) {
        errorCount++;
        console.warn(`Auto-Revoke einzelnes Device fehlgeschlagen (${row.device_id}):`, e.message);
      }
    }
    if (staleRows.length > 0) {
      console.log(`🧹 Auto-Revoke: ${revokedCount}/${staleRows.length} inaktive Devices entfernt (>${Math.round(inactivityMs / 86400_000)}d)`);
    }
  } catch (e) {
    errorCount++;
    console.error("❌ Auto-Revoke Cron fehlgeschlagen:", e);
  }

  return { revoked: revokedCount, errors: errorCount };
}

async function _revokedRetention(env) {
  // Audit-Forensik: revoked Rows nach 90 Tagen endgültig löschen.
  try {
    const cutoff = Date.now() - 90 * 86400_000;
    const result = await env.RENEX_DB.prepare(
      "DELETE FROM devices WHERE state = 'revoked' AND revoked_at < ?"
    ).bind(cutoff).run();
    const changes = result.meta?.changes ?? 0;
    if (changes > 0) {
      console.log(`🧹 Revoked-Retention: ${changes} alte Device-Rows gelöscht (>90d)`);
    }
  } catch (e) {
    console.error("❌ Revoked-Retention fehlgeschlagen:", e);
  }
}
