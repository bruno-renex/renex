export default {
  // ── index.html / Login ──────────────────────────────
  loginPlaceholder:    "Name",
  loginBtn:            "Login with Passkey",
  loginAuthenticating: "Authenticating…",
  loginEnterName:      "Please enter a name",
  loginFailed:         "Login failed",

  // ── inbox.html ──────────────────────────────────────
  inboxPageTitle:           "RENEX – Inbox",
  addContactHeading:        "Add contact",
  addContactPlaceholder:    "Handle (e.g. bob)",
  addContactBtn:            "Send request",
  pendingHeading:           "Pending requests",
  contactsHeading:          "Contacts",
  deleteAccount:            "Delete account",
  logout:                   "Logout",
  langToggleLabel:          "Language",
  settings:                 "Settings",

  // ── Delete-Account-Dialog ───────────────────────────
  deleteAccountDialogTitle:   "Delete account",
  deleteAccountDialogBody:    "This action is irreversible. All messages and contacts will be deleted.<br><br>Enter your handle to confirm:",
  deleteAccountPlaceholder:   "Your handle",
  cancelBtn:                  "Cancel",
  deleteAccountConfirmBtn:    "Delete account",

  // ── inbox.js (dynamic strings) ───────────────────────
  cryptoInitFailed:       "Cryptography could not be initialized",
  noContacts:             "No contacts yet",
  noPendingRequests:      "No pending requests",
  loadContactsFailed:     "Failed to load contacts",
  requestSent:            " (request sent)",
  acceptBtn:              "Accept",
  rejectBtn:              "Reject",
  accountDeleted:         " (account deleted)",
  removeFromList:         "Remove from list",
  handleMismatch:         "Handle does not match",
  contactRequestFailed:   "Contact request failed",
  removeContactFailed:    "Could not remove contact",
  confirmRemoveContact:   (handle) => `Really remove contact ${handle}?`,

  // ── chat/index.html ──────────────────────────────────
  chatPageTitle:        "Chat",
  messagePlaceholder:   "Message…",
  sendBtn:              "Send",
  newMessagesSuffix:    " new messages ↓",

  // ── chat.js (dynamic strings) ────────────────────────
  noChatPartner:      "No chat partner selected",
  chatWith:           (user) => `Chat with ${user}`,
  sendFailed:         "Message could not be sent",
  maxLengthReached:   (max) => `Maximum ${max} characters reached`,
  charCounter:        (len, max) => `${len} / ${max} characters`,
  pleaseWait:         "Please wait a moment…",

  // ── Locale ───────────────────────────────────────────
  locale: "en-GB",
};
