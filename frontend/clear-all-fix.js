(() => {
  const API = "/api/v1";
  let busy = false;

  async function clearAll() {
    if (busy) return;
    const password = document.getElementById("clearAllPassword")?.value?.trim() || "";
    const status = document.getElementById("clearAllStatus");
    if (!password) {
      if (status) status.textContent = "Enter your password to confirm.";
      return;
    }
    busy = true;
    if (status) status.textContent = "Clearing all data…";
    try {
      const response = await fetch(`${API}/admin/clear-all`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const input = document.getElementById("clearAllPassword");
      if (input) input.value = "";
      if (status) status.textContent = `Cleared. Removed ${Number(data.r2_objects_deleted || 0)} cached audio file(s).`;
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      if (status) status.textContent = error?.message || "Clear All Data failed.";
    } finally {
      busy = false;
    }
  }

  function bind() {
    const button = document.getElementById("clearAllGo");
    if (!button || button.dataset.clearAllBound === "1") return;
    button.dataset.clearAllBound = "1";
    button.addEventListener("click", clearAll);
    document.getElementById("clearAllPassword")?.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        clearAll();
      }
    });
  }

  bind();
  new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
})();
