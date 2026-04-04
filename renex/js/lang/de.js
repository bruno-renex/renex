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
  addContactPlaceholder:    "Username",
  addContactBtn:            "Anfrage senden",
  pendingHeading:           "Offene Anfragen",
  contactsHeading:          "Kontakte",
  deleteAccount:            "Account löschen",
  logout:                   "Logout",
  langToggleLabel:          "Sprache",
  settings:                 "Einstellungen",

  // ── Tabs ─────────────────────────────────────────────
  tabChats:             "Kontakte & Chats",
  tabGroups:            "Gruppen",
  tabContacts:          "Kontakte",

  // ── Gruppen ──────────────────────────────────────────
  groupNamePlaceholder: "Gruppenname",
  createGroupBtn:       "Gruppe erstellen",
  noGroups:             "Noch keine Gruppen.",
  loadingText:          "Lädt…",
  youSuffix:            " (Du)",
  loadError:            "Fehler beim Laden",
  memberLabel:          "(Mitglied)",
  inviteBtn:            "+ Einladen",
  invitePlaceholder:    "Username…",
  alreadyMember:        (handle) => `${handle} ist bereits Mitglied.`,
  userNotFound:         (handle) => `Nutzer „${handle}" existiert nicht.`,
  notInContacts:        (handle) => `„${handle}" ist nicht in deinen Kontakten. Füge ihn/sie zuerst als Kontakt hinzu.`,
  inviteFailed:         "Einladen fehlgeschlagen: ",
  leaveGroupBtn:        "Verlassen",
  confirmLeaveGroup:    (name) => `Gruppe "${name}" verlassen?`,
  leaveFailed:          "Verlassen fehlgeschlagen: ",
  createGroupFailed:    "Gruppe erstellen fehlgeschlagen: ",
  groupDetails:         "Gruppendetails",
  newMessage:           "Neue Nachricht",
  noMessages:           "Noch keine Nachrichten",
  yesterday:            "Gestern",
  youPrefix:            "Du: ",

  // ── Chat-Menü ─────────────────────────────────────────
  autoDeleteOff:        "Aus",
  autoDeleteOneHour:    "1h",
  autoDeleteOneDay:     "24h",
  autoDeleteOneWeek:    "7 Tage",
  autoDeleteThirtyDays: "30 Tage",
  membersHeading:       "Mitglieder",

  // ── Chat-Nachrichten ──────────────────────────────────
  decryptFailed:          "🔒 Nachricht konnte nicht entschlüsselt werden",
  messageExpired:         "⏱ Nachricht automatisch gelöscht",
  deleteMessageTitle:     "Nachricht löschen",
  confirmDeleteMessage:   "Nachricht für alle löschen?",
  statusDelivered:        "Zugestellt",
  statusSent:             "Gesendet",
  messageDeleted:         "🗑️ Nachricht gelöscht",
  noPeerKey:              "🔐 Peer hat noch keinen Public Key",

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
