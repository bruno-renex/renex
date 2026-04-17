// ======================================================
// CREDENTIALS HELPER: Multi-Passkey KV Lese-/Schreib-Logik
// ======================================================

const MAX_PASSKEYS = 10;
export { MAX_PASSKEYS };

/**
 * Liest alle Credentials eines Users aus KV.
 * Migriert automatisch vom alten Single-Credential-Format zum neuen Array-Format.
 * @returns {Array|null} Array von Credential-Objekten oder null wenn User nicht existiert
 */
export async function readCredentials(env, handle) {
  const raw = await env.RENEX_KV.get(`webauthn:${handle}`);
  if (!raw) return null;

  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }

  // Neues Format: { credentials: [...] }
  if (Array.isArray(obj.credentials)) return obj.credentials;

  // Altes Format: { credential_id, publicKeyJwk, created_at, signCount? }
  if (obj.credential_id && obj.publicKeyJwk) {
    const migrated = [{
      credential_id: obj.credential_id,
      publicKeyJwk:  obj.publicKeyJwk,
      created_at:    obj.created_at || Date.now(),
      signCount:     obj.signCount || 0,
      name:          null,
      last_used:     obj.updated_at || null,
    }];
    // Persistiere migriertes Format
    await env.RENEX_KV.put(`webauthn:${handle}`, JSON.stringify({ credentials: migrated }));
    return migrated;
  }

  return null;
}

/**
 * Schreibt Credentials-Array in KV.
 */
export async function writeCredentials(env, handle, credentials) {
  await env.RENEX_KV.put(`webauthn:${handle}`, JSON.stringify({ credentials }));
}
