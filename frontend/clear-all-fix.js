(() => {
  const API = "/api/v1";
  let busy = false;

  async function clearAll(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (busy) return;
    const password = document.getElementById("clearAllPassword")?.value?.trim() || "";
    const status = document.getElementById("clearAllStatus");
    if (!password) {
      if (status) status.textContent = "Enter your password to confirm.";
      document.getElementById("clearAllPassword")?.focus();
      return;
    }
    busy = true;
    const button = document.getElementById("clearAllGo");
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
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
      const currentButton = document.getElementById("clearAllGo");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.removeAttribute("aria-busy");
      }
    }
  }

  function bind() {
    const button = document.getElementById("clearAllGo");
    if (!button) return;

    // The original UI used a <div class="go"> rather than a native button.
    // Upgrade it in-place so mouse/touch/keyboard activation is reliable.
    if (button.tagName !== "BUTTON") {
      const replacement = document.createElement("button");
      replacement.type = "button";
      replacement.id = button.id;
      replacement.className = button.className;
      replacement.textContent = button.textContent;
      replacement.setAttribute("aria-label", "Clear All Data");
      button.replaceWith(replacement);
    }

    const current = document.getElementById("clearAllGo");
    if (!current || current.dataset.clearAllBound === "1") return;
    current.dataset.clearAllBound = "1";
    current.style.pointerEvents = "auto";
    current.style.cursor = "pointer";
    current.addEventListener("click", clearAll);

    document.getElementById("clearAllPassword")?.addEventListener("keydown", event => {
      if (event.key === "Enter") clearAll(event);
    });
  }

  bind();
  document.addEventListener("click", event => {
    const target = event.target?.closest?.("#clearAllGo");
    if (target && target.dataset.clearAllBound !== "1") {
      bind();
      const button = document.getElementById("clearAllGo");
      if (button?.dataset.clearAllBound === "1") clearAll(event);
    }
  }, true);
  new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
})();
