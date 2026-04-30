// ======================================================
// One-shot Backfill: KV inbox-indices → D1 `devices`-Tabelle
// Spec: docs/MULTI_DEVICE.md §7.1
//
// Wird über /admin/backfill-devices (POST) getriggert,
// gegated durch env.ADMIN_TOKEN.
//
// Idempotent: INSERT ON CONFLICT DO NOTHING. Mehrfache Runs sind safe.
// Bestehende Devices erhalten state='active' (nicht 'syncing'),
// weil sie vor der Migration produktiv waren.
// ======================================================

export async function runBackfillDevices(env) {
  const startedAt = Date.now();
  const stats = {
    kvKeysScanned: 0,
    deviceIdsSeen: 0,
    devicesInserted: 0,
    devicesAlreadyExist: 0,
    skippedInvalid: 0,
    errors: [],
  };

  let cursor = undefined;
  let pages = 0;

  do {
    const listResult = await env.RENEX_KV.list({
      prefix: 'e2e:inbox:index:',
      cursor,
    });
    pages++;

    for (const { name } of listResult.keys) {
      stats.kvKeysScanned++;
      const handle = name.slice('e2e:inbox:index:'.length);
      if (!handle || !/^[a-z0-9_]+$/.test(handle)) {
        stats.skippedInvalid++;
        continue;
      }

      const raw = await env.RENEX_KV.get(name);
      let deviceIds = [];
      try {
        deviceIds = JSON.parse(raw || '[]');
      } catch {
        stats.errors.push({ kvKey: name, error: 'json_parse_failed' });
        continue;
      }
      if (!Array.isArray(deviceIds)) {
        stats.errors.push({ kvKey: name, error: 'not_an_array' });
        continue;
      }

      const now = Date.now();
      for (const deviceId of deviceIds) {
        stats.deviceIdsSeen++;
        if (
          typeof deviceId !== 'string' ||
          deviceId.length < 8 ||
          deviceId.length > 64
        ) {
          stats.skippedInvalid++;
          continue;
        }

        try {
          const result = await env.RENEX_DB.prepare(`
            INSERT INTO devices
              (device_id, user_handle, state, created_at, last_seen_at)
            VALUES (?, ?, 'active', ?, ?)
            ON CONFLICT(device_id) DO NOTHING
          `).bind(deviceId, handle, now, now).run();

          if ((result.meta?.changes ?? 0) > 0) {
            stats.devicesInserted++;
          } else {
            stats.devicesAlreadyExist++;
          }
        } catch (e) {
          stats.errors.push({
            deviceId,
            handle,
            error: e.message?.slice(0, 200) || 'unknown',
          });
        }
      }
    }

    cursor = listResult.list_complete ? null : listResult.cursor;
  } while (cursor);

  stats.pages = pages;
  stats.durationMs = Date.now() - startedAt;

  console.log('🔁 Backfill-Devices abgeschlossen:', JSON.stringify(stats));
  return stats;
}
