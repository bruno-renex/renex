// ======================================================
// CHAT CONSTANTS & SHARED CONFIG
// ======================================================

// CONFIG
export const API = "https://api.renex.id";
export const MAX_MESSAGE_LENGTH = 1000;
export const SEND_COOLDOWN_MS = 2000;
export const EPOCH_MS = 3_600_000;
export const ROTATION_THRESHOLD = 50;
export const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_DEFERRED_BACKOFF = 15000;
export const MAX_INBOUND_RETRIES = 4;
export const MAX_DECRYPT_CACHE = 2000;
export const INBOX_KEY_TTL = 30_000;
export const REACTION_EMOJIS = ["💀","🔥","🗿","😭","🫡","💯","🤝"];

// Guest session (read-only, computed once)
export const _guestData = (() => {
  try { return JSON.parse(sessionStorage.getItem("guestSession") || "null"); } catch { return null; }
})();
export const _isGuestMode = !!(_guestData?.guestHandle && _guestData?.token);

// Validation patterns
export const _VALID_HANDLE = /^[a-z0-9_]{1,64}$/i;
export const _VALID_UUID   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const _VALID_DM_ID  = /^[a-z0-9_]{1,32}:[a-z0-9_]{1,32}$/i;
