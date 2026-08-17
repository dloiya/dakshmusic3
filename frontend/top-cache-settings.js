(() => {
  const API = "/api/v1";
  let busy = false;

  async function populate() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`${API}/cache/top/populate`, { method: "POST", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || `HTTP ${response.status}`);
      alert(data.message || "Top Cache population started.");
    } catch (error) {
      alert(error.message || "Unable to populate Top Cache.");
    } finally {
      busy = false;
    }
  }

  function inject() {
    const list = document.getElementById("list-settings");
    if (!list || list.querySelector("[data-daksh-populate-top-cache]")) return;
    const li = document.createElement("li");
    li.dataset.dakshPopulateTopCache = "1";
    li.innerHTML = '<div class="l"><span class="name">Populate Top Cache</span></div><span class="chev">▸</span>';
    li.addEventListener("click", populate);
    list.appendChild(li);
  }

  new MutationObserver(inject).observe(document.body, { subtree: true, childList: true });
  inject();
})();
