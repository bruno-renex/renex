# RENEX — Threat Model

> **Pre-beta status (2026-05-21):** This threat model documents the security assumptions, asset classification, and acknowledged weaknesses of RENEX Protocol v1 in its current pre-beta implementation. **The protocol has not undergone external audit.** Until v1.0 audit completion (planned Year 2), do not rely on RENEX for high-risk threat scenarios.

**Version:** 0.1 (pre-beta)
**Last updated:** 2026-05-21
**Maintainer:** Bruno Hochstrasser

---

## 1. Scope

### 1.1 What this document covers
- The trust model for the reference RENEX server + RENEX client
- The cryptographic assumptions in [`PROTOCOL.md`](./PROTOCOL.md), [`MULTI_DEVICE.md`](./MULTI_DEVICE.md), [`RECOVERY.md`](./RECOVERY.md)
- The adversaries we explicitly defend against and those we don't
- Known weaknesses with migration plans

### 1.2 What this document does NOT cover
- Operational security of the user (device theft, shoulder surfing, weak passkey storage)
- Browser/OS-level vulnerabilities outside the client's control
- WebAuthn implementation bugs in specific authenticators
- Vulnerabilities in dependencies (mitigated via Dependabot, not enumerated here)

---

## 2. Assets

Listed in order of sensitivity:

| Asset | Sensitivity | Location |
|---|---|---|
| Message plaintext | HIGH | Client-side only, ephemeral in memory + IDB (encrypted at rest) |
| CMK (Conversation Master Key) | HIGH | Client-side IDB, encrypted with device-storage-key |
| GSK (Group Sender Key) | HIGH | Client-side IDB per (user, group), encrypted |
| BIP39 recovery phrase | CRITICAL | User-owned (paper); derived master-key cached client-side encrypted |
| WebAuthn private key | CRITICAL | Hardware-bound (TPM, Secure Enclave, hardware key) |
| R2 backup bundle | MEDIUM (encrypted) | Server-side R2, encrypted with master-key (BIP39-derived) |
| Device pubkey + handle binding | LOW | Server-side D1 (public information) |
| Conversation metadata (who→who, when) | MEDIUM | Server-side D1 (correlation visible) |
| TURN relay traffic | LOW (encrypted) | Hetzner coturn — encrypted SRTP only |

---

## 3. Adversaries

### 3.1 Defended-against adversaries

**A1: Server-side adversary** (Cloudflare staff, government request, server compromise)
- Cannot decrypt message content (E2E with client-only CMK/GSK)
- Can observe metadata: conversation membership, timing, message sizes
- Mitigation: client-side encryption is non-bypassable; no key material crosses the network unencrypted

**A2: TURN-relay adversary** (Hetzner staff, coturn compromise)
- Cannot decrypt voice content (DTLS-SRTP, end-to-end)
- Can observe: IP-pairs, packet timing, call duration
- Mitigation: encrypted SRTP; coturn config rejects relay to private networks (RFC1918, CGNAT, IPv6 ULA/LL)

**A3: Network adversary** (passive eavesdropping in transit)
- TLS 1.3 for the Cloudflare-Worker WebSocket signaling
- DTLS-SRTP for voice
- Mitigation: standard TLS; protocol enforces HTTPS/WSS

**A4: Mass-scale automated bot / AI farm**
- No public API → bots require captcha-farm + reverse-engineered client
- Hardware-attestation on roadmap (Phase 9) raises per-account cost
- Mitigation: architectural anti-API + Turnstile captcha + behavioral signals (planned)

### 3.2 Partially defended-against adversaries

**A5: Single-device endpoint compromise** (malware on one of N user's devices)
- Compromised device can read all conversations until rotation
- Defense: user-initiated device revoke triggers CMK rotation
- Limitation: no Post-Compromise Security — pre-v2 Double Ratchet missing
- Mitigation timeline: Signal Protocol migration in v2 (~Q4 2026)

**A6: Targeted active MITM during device addition**
- TOFU model: new device shows toast on existing devices ("Was that you?")
- Defense: passkey-bound auth (server-only compromise insufficient)
- Limitation: no out-of-band verification (safety-number-style)
- Mitigation timeline: OOB device-verification channel on roadmap

### 3.3 Adversaries explicitly NOT defended against

**A7: Full endpoint compromise** (root access on all user devices)
- Out of scope — standard for any client-side-encryption system
- User responsibility: hardware-bound passkeys, OS patching, disk encryption

**A8: Loss of recovery phrase AND all devices**
- Account is permanently unrecoverable by design (no backdoor)
- Documented in [`MANIFESTO.md`](./MANIFESTO.md) §1 — accepted UX cost for true E2E

**A9: Coerced disclosure of recovery phrase**
- No plausible-deniability mode (planned post-v1)
- User responsibility: secure storage of paper phrase

**A10: Quantum-capable adversary against past traffic**
- Current crypto (ECDH P-256) is not post-quantum
- Roadmap: hybrid post-quantum KEM migration when WebCrypto API adds support

---

## 4. Acknowledged Weaknesses (pre-beta)

Known design limitations that v2 will address:

| Weakness | Current State | v2 Plan |
|---|---|---|
| No Post-Compromise Security (CMK persists until manual rotation) | Pre-beta | Signal Protocol Double Ratchet, post-beta Q4 2026 |
| FS asymmetry: Groups have per-message chainIndex, DMs have hourly epoch | Pre-beta | Symmetric per-message chain in v2 |
| TOFU-only device verification | Pre-beta | Out-of-band verification channel |
| PBKDF2-SHA256 (600k iters) for BIP39 → master-key | Pre-beta | Argon2id evaluation pre-v1.0 |
| No reproducible-build hashes per release | Pre-beta | Hash-publish in release notes + native builds (Capacitor/Tauri) |
| Single-server topology (no federation) | Pre-beta | Federation spec — v3 roadmap |
| Cloudflare-dependent reference server | Pre-beta | Documented as reference-impl lock-in, protocol portable |

---

## 5. Cryptographic Primitives Summary

For details see [`PROTOCOL.md`](./PROTOCOL.md) §4 and individual sub-specs.

| Purpose | Algorithm | Notes |
|---|---|---|
| Symmetric encryption | AES-256-GCM (96-bit IV) | WebCrypto-native |
| Key agreement | ECDH P-256 | WebCrypto-native |
| Signatures | ECDSA P-256 SHA-256 | WebCrypto-native |
| Key derivation | HKDF-SHA256 | Used for CMK→SK→MK + GSK→MK |
| Password-based KDF | PBKDF2-SHA256, 600k iterations | BIP39 → master-key (Argon2id consideration pending) |
| Recovery encoding | BIP39 12-word | Standard mnemonic |

---

## 6. Reporting and Updating

Report suspected vulnerabilities via [`SECURITY.md`](../SECURITY.md). This threat model is updated whenever protocol versions change or new attack vectors are identified.

---

**Document version:** 0.1 (pre-beta)
**Stable v1.0 target:** Post external audit (Year 2)
