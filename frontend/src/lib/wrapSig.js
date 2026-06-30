// ======================================================
// Wrap-Signatur (Phase 0.3) — ECDSA-P256 über CMK-/GSK-Wrap-Payloads
// ======================================================
// Signiert den Wrap-Payload mit dem Identitäts-Sig-Key des Absenders und bindet
// damit FÄLSCHUNGSSICHER: algoVersion (→ Downgrade-Schutz: ein Angreifer kann das
// Hybrid-Flag nicht strippen), Empfänger-deviceId (→ kein Re-Targeting), und den
// Ciphertext (→ kein Tampering). Authentifiziert zugleich den Wrap, der heute
// TOFU-ungeschützt ist (der Relay-Server könnte einen Wrap injizieren).
//
// DARK-LAUNCH: Neue Clients SIGNIEREN beim Erzeugen und VERIFIZIEREN+LOGGEN beim
// Lesen, REJECTEN aber (noch) NICHT — alte Clients senden keine Sig, neue müssen
// das tolerieren, sonst bricht der Key-Exchange in gemischter Flotte. Enforcement
// (= echter Downgrade-Schutz) ist ein späterer Flag, sobald alle Clients signieren.
//
// Bewusst OHNE cmk.js-Import (sonst Zyklus, da cmk.js signWrapPayload importiert):
// die Sig-Pubkey-Beschaffung (getSigPubForDevice) bleibt an der Call-Site.
// ======================================================
import { loadSigningPrivKey } from './e2eKeys.js';
import { bytesToB64, b64ToBytes } from './bytes.js';

// Kanonische, domain-separierte Serialisierung der sicherheitsrelevanten Felder.
// Feste Reihenfolge; '\n'-Trenner (Felder sind base64/ascii, enthalten kein '\n').
// wrapSig selbst ist NICHT Teil der Signatur (es IST die Signatur).
export function canonicalWrap(p) {
  return [
    'renex:cmkwrap:v1',
    String(p?.algoVersion ?? ''),
    String(p?.fromDeviceId ?? ''),
    String(p?.deviceId ?? ''),
    String(p?.ivB64 ?? ''),
    String(p?.ctB64 ?? ''),
  ].join('\n');
}

/**
 * Signiert einen Wrap-Payload. Best-effort: ohne Sig-Key → null (Wrap geht im
 * Dark-Launch trotzdem raus). Gibt base64-Signatur oder null.
 */
export async function signWrapPayload(payload) {
  try {
    const priv = await loadSigningPrivKey();
    if (!priv) return null;
    const data = new TextEncoder().encode(canonicalWrap(payload));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data);
    return bytesToB64(new Uint8Array(sig));
  } catch {
    return null;
  }
}

/**
 * Verifiziert die Wrap-Signatur gegen den Sig-Pubkey des Absenders.
 * Wirft NIE (Dark-Launch-tauglich).
 * @returns {Promise<{ok: boolean, reason: 'ok'|'invalid'|'missing'|'no_pubkey'|'error'}>}
 */
export async function verifyWrapPayload(payload, sigPubJwk) {
  const sigB64 = payload?.wrapSig;
  if (typeof sigB64 !== 'string' || !sigB64) return { ok: false, reason: 'missing' };
  if (!sigPubJwk) return { ok: false, reason: 'no_pubkey' };
  try {
    const pub = await crypto.subtle.importKey(
      'jwk', sigPubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    const data = new TextEncoder().encode(canonicalWrap(payload));
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pub, b64ToBytes(sigB64), data
    );
    return { ok, reason: ok ? 'ok' : 'invalid' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Dark-Launch-Verifikation: verifiziert + loggt nur (kein Reject, wirft NIE).
 * `reason==='missing'` (alter Client ohne Sig) wird NICHT geloggt — im Dark-Launch
 * erwartet und kein Signal. Nur invalid/error/no_pubkey loggen (potenzielle
 * Manipulation oder fehlender Pubkey).
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function logWrapVerify(payload, sigPubJwk, ctx) {
  const v = await verifyWrapPayload(payload, sigPubJwk);
  if (v.reason !== 'ok' && v.reason !== 'missing') {
    console.warn(`🔏 wrap_sig ${v.reason} ${ctx || ''}`.trim());
  }
  return v;
}
