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

    if (removedMembers > 0) {
      console.log(`🧹 Guest-Cleanup: ${removedMembers} abgelaufene Gast-Mitgliedschaften entfernt`);
    }
  } catch (e) {
    console.error("❌ Guest-Cleanup Cron fehlgeschlagen:", e);
  }
}
