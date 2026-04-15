// ======================================================
// CRON: Automatische Nachrichten-Löschung (täglich 03:00 UTC)
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
}
