export async function apiFetch(path, options = {}) {
  const res = await fetch("https://api.renex.id" + path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    }
  });

  if (res.status === 401) {
    console.warn("🔒 Session expired");
    localStorage.removeItem("my_user");
    window.location.replace("/index.html");
    throw new Error("Session expired");
  }

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    return {
      rateLimited: true,
      error: data.error || "Too many requests"
    };
  }

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch {}
    throw new Error(`API ${res.status}: ${msg}`);
  }

  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    console.warn("⚠️ Invalid JSON from server");
    return {};
  }
}