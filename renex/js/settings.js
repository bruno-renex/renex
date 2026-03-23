import { apiFetch } from "./api.js";
import { getLang, setLang } from "./i18n.js";

// Auth-Guard
if (!localStorage.getItem("my_user")) {
  location.href = "/login.html";
}

function showToast() {
  const t = document.getElementById("save-toast");
  if (!t) return;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// ── Sprache ──────────────────────────────────────────────
const langSelect = document.getElementById("lang-select");
if (langSelect) {
  langSelect.value = getLang();
  langSelect.addEventListener("change", () => {
    setLang(langSelect.value);
    showToast();
  });
}

// ── Auto-Delete Global ───────────────────────────────────
const autoDeleteSelect = document.getElementById("auto-delete-select");

async function loadAutoDeleteSetting() {
  try {
    const s = await apiFetch("/settings");
    const days = s?.autoDeleteDays ?? null;
    if (autoDeleteSelect) autoDeleteSelect.value = days === null ? "" : String(days);
  } catch (e) {
    console.warn("⚠️ Settings laden fehlgeschlagen", e);
  }
}

if (autoDeleteSelect) {
  loadAutoDeleteSetting();
  autoDeleteSelect.addEventListener("change", async () => {
    const val = autoDeleteSelect.value;
    const days = val === "" ? null : Number(val);
    try {
      await apiFetch("/settings", {
        method: "POST",
        body: JSON.stringify({ autoDeleteDays: days })
      });
      showToast();
    } catch (e) {
      console.warn("⚠️ Auto-Delete speichern fehlgeschlagen", e);
    }
  });
}
