export default {
  // ── index.html / Login ──────────────────────────────
  loginPlaceholder:    "Name",
  loginBtn:            "Login mit Passkey",
  loginAuthenticating: "Authentifiziere…",
  loginEnterName:      "Bitte Namen eingeben",
  loginFailed:         "Login fehlgeschlagen",

  // ── inbox.html ──────────────────────────────────────
  inboxPageTitle:           "RENEX – Inbox",
  addContactHeading:        "Kontakt hinzufügen",
  addContactPlaceholder:    "Handle (z. B. bob)",
  addContactBtn:            "Anfrage senden",
  pendingHeading:           "Offene Anfragen",
  contactsHeading:          "Kontakte",
  deleteAccount:            "Account löschen",
  logout:                   "Logout",
  langToggleLabel:          "Sprache",

  // ── Delete-Account-Dialog ───────────────────────────
  deleteAccountDialogTitle:   "Account löschen",
  deleteAccountDialogBody:    "Diese Aktion ist unwiderruflich. Alle Nachrichten und Kontakte werden gelöscht.<br><br>Gib deinen Handle zur Bestätigung ein:",
  deleteAccountPlaceholder:   "Dein Handle",
  cancelBtn:                  "Abbrechen",
  deleteAccountConfirmBtn:    "Account löschen",

  // ── inbox.js (dynamic strings) ───────────────────────
  cryptoInitFailed:       "Kryptografie konnte nicht initialisiert werden",
  noContacts:             "Noch keine Kontakte",
  noPendingRequests:      "Keine offenen Anfragen",
  loadContactsFailed:     "Fehler beim Laden der Kontakte",
  requestSent:            " (Anfrage gesendet)",
  acceptBtn:              "Annehmen",
  rejectBtn:              "Ablehnen",
  accountDeleted:         " (Konto gelöscht)",
  removeFromList:         "Aus Liste entfernen",
  handleMismatch:         "Handle stimmt nicht überein",
  contactRequestFailed:   "Kontaktanfrage fehlgeschlagen",
  removeContactFailed:    "Kontakt konnte nicht entfernt werden",
  confirmRemoveContact:   (handle) => `Kontakt ${handle} wirklich entfernen?`,

  // ── chat/index.html ──────────────────────────────────
  chatPageTitle:        "Chat",
  messagePlaceholder:   "Nachricht…",
  sendBtn:              "Senden",
  newMessagesSuffix:    " neue Nachrichten ↓",

  // ── chat.js (dynamic strings) ────────────────────────
  noChatPartner:      "Kein Chat-Partner gewählt",
  chatWith:           (user) => `Chat mit ${user}`,
  sendFailed:         "Nachricht konnte nicht gesendet werden",
  maxLengthReached:   (max) => `Maximal ${max} Zeichen erreicht`,
  charCounter:        (len, max) => `${len} / ${max} Zeichen`,
  pleaseWait:         "Bitte kurz warten…",

  // ── Locale ───────────────────────────────────────────
  locale: "de-DE",
};
