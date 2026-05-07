// ======================================================
// RENEX Dialog Utility — ersetzt native prompt() / confirm()
// Dark-Theme, i18n-fähig, iOS-PWA-kompatibel
// ======================================================

let _activeDialog = null;

/**
 * Zeigt einen RENEX-gestylten Prompt-Dialog.
 * @returns {Promise<string|null>} Eingegebener Wert oder null bei Abbruch
 */
export function showPromptDialog({
  title = "",
  placeholder = "",
  defaultValue = "",
  confirmLabel = "OK",
  cancelLabel = "Abbrechen",
  maxLength = 200,
} = {}) {
  return new Promise((resolve) => {
    // Nur einen Dialog gleichzeitig
    if (_activeDialog) {
      _activeDialog.close(null);
    }

    // CSS Animation einmalig einfügen
    if (!document.getElementById("renex-dialog-style")) {
      const s = document.createElement("style");
      s.id = "renex-dialog-style";
      s.textContent = `
        @keyframes renex-dialog-in {
          from { opacity: 0; transform: scale(0.94); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes renex-dialog-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `;
      document.head.appendChild(s);
    }

    // Overlay
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;" +
      "display:flex;align-items:center;justify-content:center;padding:20px;" +
      "animation:renex-dialog-fade 0.15s ease;";

    // Dialog
    const dialog = document.createElement("div");
    dialog.style.cssText =
      "background:var(--bg-panel,#0D0D11);border:1px solid var(--border-panel,rgba(255,255,255,0.06));" +
      "border-radius:16px;padding:22px 20px 18px;width:100%;max-width:360px;" +
      "box-shadow:0 16px 48px rgba(0,0,0,0.6);" +
      "animation:renex-dialog-in 0.15s ease;";

    // Titel
    if (title) {
      const titleEl = document.createElement("div");
      titleEl.style.cssText =
        "font-size:15px;font-weight:600;color:var(--text-primary,#E6E6EB);" +
        "margin-bottom:14px;line-height:1.3;";
      titleEl.textContent = title;
      dialog.appendChild(titleEl);
    }

    // Input
    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue || "";
    input.placeholder = placeholder || "";
    input.maxLength = maxLength;
    input.autocomplete = "off";
    input.autocorrect = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    // 16px verhindert iOS Auto-Zoom beim Fokus
    input.style.cssText =
      "width:100%;padding:11px 12px;font-size:16px;" +
      "background:var(--bg-panel-alt,#121218);border:1px solid var(--border-input,#23232D);" +
      "border-radius:8px;color:var(--text-primary,#E6E6EB);outline:none;" +
      "font-family:inherit;box-sizing:border-box;transition:border-color 0.15s;";
    input.addEventListener("focus", () => {
      input.style.borderColor = "var(--accent-voice,#38BDF8)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "var(--border-input,#23232D)";
    });
    dialog.appendChild(input);

    // Button Row
    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";

    // Cancel Button
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText =
      "padding:9px 16px;border-radius:8px;border:1px solid var(--border-subtle,#1C1C24);" +
      "background:var(--bg-panel-alt,#121218);color:var(--text-secondary,#9A9AA3);" +
      "font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;" +
      "transition:opacity 0.15s;";
    cancelBtn.addEventListener("mouseover", () => cancelBtn.style.opacity = "0.8");
    cancelBtn.addEventListener("mouseout", () => cancelBtn.style.opacity = "1");
    btnRow.appendChild(cancelBtn);

    // OK Button
    const okBtn = document.createElement("button");
    okBtn.textContent = confirmLabel;
    okBtn.style.cssText =
      "padding:9px 18px;border-radius:8px;border:none;" +
      "background:var(--accent-voice,#38BDF8);color:#07070A;" +
      "font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;" +
      "transition:opacity 0.15s;";
    okBtn.addEventListener("mouseover", () => okBtn.style.opacity = "0.88");
    okBtn.addEventListener("mouseout", () => okBtn.style.opacity = "1");
    btnRow.appendChild(okBtn);

    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);

    // Close-Mechanismus
    const close = (value) => {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.style.opacity = "0";
      overlay.style.transition = "opacity 0.12s ease";
      setTimeout(() => overlay.remove(), 140);
      _activeDialog = null;
      resolve(value);
    };

    // Event-Handler
    okBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      close(input.value.trim());
    });
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      close(null);
    });

    // Backdrop-Click schliesst (nur direkter Klick auf Overlay, nicht Dialog)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    // Dialog-Click nicht weitergeben
    dialog.addEventListener("click", (e) => e.stopPropagation());

    // Keyboard: Enter = OK, Escape = Cancel
    const onKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close(input.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener("keydown", onKeydown, true);

    // DOM hinzufügen + fokussieren
    document.body.appendChild(overlay);
    _activeDialog = { close };

    // Auto-Focus + Select bei defaultValue
    requestAnimationFrame(() => {
      input.focus();
      if (defaultValue) {
        input.select();
      }
    });
  });
}
