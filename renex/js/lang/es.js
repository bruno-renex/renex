export default {
  // ── index.html / Login ──────────────────────────────
  loginPlaceholder:    "Nombre",
  loginBtn:            "Iniciar sesión con Passkey",
  loginAuthenticating: "Autenticando…",
  loginEnterName:      "Por favor ingresa un nombre",
  loginFailed:         "Error al iniciar sesión",

  // ── inbox.html ──────────────────────────────────────
  inboxPageTitle:           "RENEX – Inbox",
  addContactHeading:        "Añadir contacto",
  addContactPlaceholder:    "Username",
  addContactBtn:            "Enviar solicitud",
  pendingHeading:           "Solicitudes pendientes",
  contactsHeading:          "Contactos",
  deleteAccount:            "Eliminar cuenta",
  logout:                   "Cerrar sesión",
  langToggleLabel:          "Idioma",
  settings:                 "Ajustes",

  // ── Tabs ─────────────────────────────────────────────
  tabChats:             "Contactos & Chats",
  tabGroups:            "Grupos",
  tabContacts:          "Contactos",

  // ── Grupos ───────────────────────────────────────────
  groupNamePlaceholder: "Nombre del grupo",
  createGroupBtn:       "Crear grupo",
  noGroups:             "Aún no hay grupos.",
  loadingText:          "Cargando…",
  youSuffix:            " (Tú)",
  loadError:            "Error al cargar",
  memberLabel:          "(Miembro)",
  inviteBtn:            "+ Invitar",
  invitePlaceholder:    "Username…",
  alreadyMember:        (handle) => `${handle} ya es miembro.`,
  userNotFound:         (handle) => `El usuario "${handle}" no existe.`,
  notInContacts:        (handle) => `"${handle}" no está en tus contactos. Agrégalo primero como contacto.`,
  inviteFailed:         "Error al invitar: ",
  leaveGroupBtn:        "Salir",
  confirmLeaveGroup:    (name) => `¿Salir del grupo "${name}"?`,
  leaveFailed:          "Error al salir: ",
  createGroupFailed:    "Error al crear grupo: ",
  groupDetails:         "Detalles del grupo",
  newMessage:           "Nuevo mensaje",
  noMessages:           "Sin mensajes aún",
  yesterday:            "Ayer",
  youPrefix:            "Tú: ",

  // ── Menú de chat ─────────────────────────────────────
  autoDeleteOff:        "Desactivado",
  autoDeleteOneHour:    "1h",
  autoDeleteOneDay:     "24h",
  autoDeleteOneWeek:    "7 días",
  autoDeleteThirtyDays: "30 días",
  membersHeading:       "Miembros",

  // ── Mensajes de chat ──────────────────────────────────
  decryptFailed:          "🔒 No se pudo descifrar el mensaje",
  messageExpired:         "⏱ Mensaje eliminado automáticamente",
  deleteMessageTitle:     "Eliminar mensaje",
  confirmDeleteMessage:   "¿Eliminar mensaje para todos?",
  statusDelivered:        "Entregado",
  statusSent:             "Enviado",
  messageDeleted:         "🗑️ Mensaje eliminado",
  noPeerKey:              "🔐 El contacto aún no tiene clave pública",

  // ── Delete-Account-Dialog ───────────────────────────
  deleteAccountDialogTitle:   "Eliminar cuenta",
  deleteAccountDialogBody:    "Esta acción es irreversible. Todos los mensajes y contactos serán eliminados.<br><br>Ingresa tu nombre de usuario para confirmar:",
  deleteAccountPlaceholder:   "Tu username",
  cancelBtn:                  "Cancelar",
  deleteAccountConfirmBtn:    "Eliminar cuenta",

  // ── inbox.js (dynamic strings) ───────────────────────
  cryptoInitFailed:       "No se pudo inicializar la criptografía",
  noContacts:             "Aún no hay contactos",
  noPendingRequests:      "No hay solicitudes pendientes",
  loadContactsFailed:     "Error al cargar los contactos",
  requestSent:            " (solicitud enviada)",
  acceptBtn:              "Aceptar",
  rejectBtn:              "Rechazar",
  accountDeleted:         " (cuenta eliminada)",
  removeFromList:         "Eliminar de la lista",
  handleMismatch:         "El nombre de usuario no coincide",
  contactRequestFailed:   "Error al enviar la solicitud",
  removeContactFailed:    "No se pudo eliminar el contacto",
  confirmRemoveContact:   (handle) => `¿Eliminar el contacto ${handle}?`,

  // ── chat/index.html ──────────────────────────────────
  chatPageTitle:        "Chat",
  messagePlaceholder:   "Mensaje…",
  sendBtn:              "Enviar",
  newMessagesSuffix:    " mensajes nuevos ↓",

  // ── chat.js (dynamic strings) ────────────────────────
  noChatPartner:      "Ningún contacto seleccionado",
  chatWith:           (user) => `Chat con ${user}`,
  sendFailed:         "No se pudo enviar el mensaje",
  maxLengthReached:   (max) => `Máximo de ${max} caracteres alcanzado`,
  charCounter:        (len, max) => `${len} / ${max} caracteres`,
  pleaseWait:         "Por favor espera un momento…",

  // ── Locale ───────────────────────────────────────────
  locale: "es-ES",
};
