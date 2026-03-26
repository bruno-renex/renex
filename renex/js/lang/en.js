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
  addContactPlaceholder:    "Username",
  addContactBtn:            "Send request",
  pendingHeading:           "Pending requests",
  contactsHeading:          "Contacts",
  deleteAccount:            "Delete account",
  logout:                   "Logout",
  langToggleLabel:          "Language",
  settings:                 "Settings",

  // ── Tabs ─────────────────────────────────────────────
  tabChats:             "Chats",
  tabGroups:            "Groups",
  tabContacts:          "Contacts",

  // ── Groups ───────────────────────────────────────────
  groupNamePlaceholder: "Group name",
  createGroupBtn:       "Create group",
  noGroups:             "No groups yet.",
  loadingText:          "Loading…",
  youSuffix:            " (You)",
  loadError:            "Failed to load",
  memberLabel:          "(Member)",
  inviteBtn:            "+ Invite",
  invitePlaceholder:    "Username…",
  alreadyMember:        (handle) => `${handle} is already a member.`,
  userNotFound:         (handle) => `User "${handle}" does not exist.`,
  notInContacts:        (handle) => `"${handle}" is not in your contacts. Add them as a contact first.`,
  inviteFailed:         "Invite failed: ",
  leaveGroupBtn:        "Leave",
  confirmLeaveGroup:    (name) => `Leave group "${name}"?`,
  leaveFailed:          "Leave failed: ",
  createGroupFailed:    "Create group failed: ",
  groupDetails:         "Group details",
  newMessage:           "New message",
  noMessages:           "No messages yet",
  yesterday:            "Yesterday",
  youPrefix:            "You: ",

  // ── Chat menu ─────────────────────────────────────────
  autoDeleteOff:        "Off",
  autoDeleteOneDay:     "1 day",
  autoDeleteOneWeek:    "1 week",
  autoDeleteFourWeeks:  "4 weeks",
  autoDeleteNinetyDays: "90 days",
  membersHeading:       "Members",

  // ── Chat messages ─────────────────────────────────────
  decryptFailed:          "🔒 Message could not be decrypted",
  deleteMessageTitle:     "Delete message",
  confirmDeleteMessage:   "Delete message for everyone?",
  statusDelivered:        "Delivered",
  statusSent:             "Sent",
  messageDeleted:         "🗑️ Message deleted",
  noPeerKey:              "🔐 Peer has no public key yet",

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
