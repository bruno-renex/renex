# coturn Hardening-Checkliste (Voice V2)

> **STATUS 2026-08-02: Der Server `turn-renex-1` (Hetzner, 178.105.129.107)
> ist GELÖSCHT und Voice global deaktiviert** (KV `rollout:flags` ohne
> `"voice":true`). Dieses Dokument bleibt als Wiederaufbau-Anleitung gültig —
> die Schritt-für-Schritt-Reaktivierung steht im internen Runbook, Abschnitt 6b.


Härtung des self-hosted **coturn** auf `turn.renex.id` (Hetzner). Adressiert
Audit-Finding **V2**: jeder authentifizierte User bekommt 1h gültige TURN-REST-
Credentials (`/voice/turn-credentials`) — der Missbrauchs-Schutz lebt in der
coturn-Config, **nicht** im Worker-Code. THREAT_MODEL.md §3 (A2) *behauptet*
„coturn rejects relay to private networks" — diese Checkliste verifiziert das.

> Datei: `/etc/turnserver.conf` · nach Änderung: `systemctl restart coturn` ·
> Logs: `journalctl -u coturn -f`

---

## 1. Auth (muss zum Worker passen)
```ini
use-auth-secret
static-auth-secret=<COTURN_SECRET>     # IDENTISCH zum Worker-Secret (wrangler secret COTURN_SECRET)
realm=turn.renex.id
```
- [ ] `static-auth-secret` == `COTURN_SECRET` im Worker (sonst 401 bei jeder Allocation).
- [ ] Verify: `turnutils_uclient -y -u <username> -w <credential> turn.renex.id` mit einem **vom Worker** ausgegebenen Cred-Paar → muss authentifizieren. (Username/Credential aus `GET /voice/turn-credentials` kopieren.)

## 2. 🔴 SSRF-via-Relay verhindern — `denied-peer-ip`
**Kritisch:** ohne diese Zeilen kann ein authentifizierter User das Relay nutzen,
um interne/Cloud-Metadaten-Netze zu erreichen (z. B. Hetzner-Metadata `169.254.169.254`,
RFC1918, localhost).
```ini
# IPv4 — private, loopback, link-local/metadata, CGNAT, reserved
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=224.0.0.0-255.255.255.255
# IPv6 — loopback, ULA, link-local
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
no-multicast-peers
```
- [ ] Alle obigen `denied-peer-ip` gesetzt (besonders `169.254.0.0/16` → Cloud-Metadata!).
- [ ] Verify: Allocation anfragen + Relay-Permission auf `169.254.169.254` / eine `10.x`-IP setzen → coturn muss **„Forbidden IP"** loggen/ablehnen.

## 3. 🟠 Bandbreiten-/Quota-Limits — Relay-Bandwidth-Theft verhindern
Jeder User bekommt 1h Creds → ohne Quota ist das Relay ein offener Proxy.
```ini
user-quota=12          # max. gleichzeitige Allocations pro Username (= V1-Pseudonym, stabil pro User)
total-quota=1200       # globaler Allocation-Cap
max-bps=256000         # ~256 kbps/Allocation (Voice braucht ~40-100 kbps) → bremst Bulk-Transfer
# bps-capacity=<n>     # optional: Gesamt-Server-Bandbreite-Cap
```
- [ ] `user-quota` + `total-quota` + `max-bps` gesetzt. *(Wichtig: V1-Deploy macht den Username pro User stabil → `user-quota` bindet jetzt korrekt pro User.)*
- [ ] Verify: >`user-quota` parallele Allocations vom selben Cred → Ablehnung; großer Bulk-Transfer → auf `max-bps` gedrosselt.

## 4. TLS / Ports
```ini
listening-port=3478
tls-listening-port=5349
# Worker bietet zusätzlich turns:443 an (Strict-Firewall-Fallback):
alt-tls-listening-port=443
cert=/etc/letsencrypt/live/turn.renex.id/fullchain.pem
pkey=/etc/letsencrypt/live/turn.renex.id/privkey.pem
no-tlsv1
no-tlsv1_1
```
- [ ] `turns:turn.renex.id:443` (aus den iceServers im Code) erreichbar + gültiges Zert.
- [ ] Verify: `openssl s_client -connect turn.renex.id:443` → Cert ok, kein TLSv1/1.1.

## 5. Allgemeine Härtung
```ini
fingerprint
stale-nonce=600
no-cli                 # oder: cli-password=<stark>
proc-user=turnserver
proc-group=turnserver
# external-ip=<public-ip>   # nur falls coturn hinter NAT (Hetzner-Cloud: meist direkte Public-IP → weglassen)
```
- [ ] `no-cli` (oder Passwort) — kein offener Admin-CLI auf 5766.
- [ ] coturn läuft als unprivilegierter User.
- [ ] Firewall: nur 3478/udp+tcp, 5349/tcp, 443/tcp offen.

## 6. Privacy / Logs
- V1 (Worker) macht den TURN-Username **handle-frei** (HMAC-Pseudonym) → coturn-Logs enthalten keinen Klartext-Handle mehr.
- [ ] Optional zusätzlich `no-stdout-log` + `simple-log` mit Log-Rotation/kurzer Retention, falls Allocation-Logs nicht gebraucht werden (minimiert Metadaten-at-rest).
- [ ] Kein `verbose`/`Verbose` in Prod (loggt sonst Peer-IPs etc.).

---

## Schnell-Verifikation (eine Runde)
1. `GET /voice/turn-credentials` (eingeloggt) → Username matcht `^\d+:[A-Za-z0-9_-]+$`, **kein** Handle drin. ✅ (durch V1 + Test abgesichert)
2. Cred-Paar mit `turnutils_uclient` gegen `turn.renex.id` → Auth ok.
3. Relay-Permission auf `169.254.169.254` + `10.0.0.1` → **abgelehnt** (Forbidden IP).
4. >`user-quota` Allocations → abgelehnt.
5. `turns:443` TLS-Handshake ok.

**Wenn 1-5 grün:** V2 erledigt. Falls `COTURN_SECRET` in Prod **nicht** gesetzt ist,
läuft der Worker auf STUN-only (kein Relay) — dann ist TURN-Abuse moot, aber Calls
hinter symmetrischem NAT scheitern (→ Secret setzen + diese Checkliste anwenden).
