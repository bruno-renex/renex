// ======================================================
// ORGS — Verified-Sender-Modell (eGov Phase 1.1)
//
// Eine Org ist ein bestehender Passkey-Account mit Eintrag in der D1-Tabelle
// `orgs` (schema-orgs.sql). Verifikation läuft registergestützt-manuell durch
// den Betreiber (Bauplan §1.1); dieses Modul liest nur.
//
// Design-Regeln (Bauplan §1.1, launch-blocking):
// - Badge-Semantik unveränderlich: „Identität geprüft am DATUM via METHODE".
// - status='suspended' ⇒ Badge verschwindet sofort (kein Zwischenzustand).
// - swiyu 2027 = nur neuer verification_method-Wert, kein Umbau.
// ======================================================

export const ORG_VERIFICATION_METHODS = new Set([
  'medreg_psyreg_refdata', // Praxen: PsyReg/MedReg (Bewilligung + Praxisadresse) + RefData-GLN
  'zefix_uid',             // KMU / eingetragene Vereine: Handelsregister / UID-Register
  'bfs_gemeinde',          // Gemeinden: amtliches BFS-Gemeindeverzeichnis + amtliche Domain
  'zewo_statuten',         // Kleinvereine ohne Registereintrag: Zewo / Steuerbefreiung / Statuten
  'domain_txt',            // optionales Zusatzsignal, nie alleiniger Anker
  'contract_invoice',      // Vertrag + Jahresrechnung an die Registeradresse (Postweg-Beweis)
  'swiyu_trust_registry',  // ab H1 2027 (Vertrauensregister / Org-Credential)
]);

// Verifizierte Org zu einem Handle lesen — oder null.
// null bei: kein Eintrag, status != 'active', ODER Tabelle (noch) nicht migriert.
// Der try/catch ist bewusst: Code kann vor der Remote-Migration deployen,
// Routen dürfen deshalb nie mit 500 antworten — es fehlt dann nur das Badge.
export async function getVerifiedOrg(env, handle) {
  const h = String(handle || '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(h)) return null;
  try {
    const row = await env.RENEX_DB.prepare(
      'SELECT org_handle, display_name, verification_method, verified_at, status FROM orgs WHERE org_handle = ? LIMIT 1'
    ).bind(h).first();
    if (!row || row.status !== 'active') return null;
    return {
      handle: row.org_handle,
      name: row.display_name,
      verificationMethod: row.verification_method,
      verifiedAt: row.verified_at,
    };
  } catch {
    return null;
  }
}
