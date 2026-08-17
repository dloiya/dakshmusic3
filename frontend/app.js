(() => {
  const API = "/api/v1";
  const DEVICE_CACHE_NAME = "device-audio-v1";
  const DEVICE_CACHE_LIMIT = 10;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  async function api(path, options = {}) {
    const res = await fetch(API + path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
    return data;
  }

  const login = password => api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
  const logout = () => api("/auth/logout", { method: "POST" }).catch(() => {});
  const searchTracks = q => api("/search?q=" + encodeURIComponent(q));
  const getPlaylist = () => api("/playlist");
  const addToPlaylist = item => api("/playlist", { method: "POST", body: JSON.stringify(item) });
  const removeFromPlaylist = entryId => api("/playlist/" + encodeURIComponent(entryId), { method: "DELETE" });
  const moveEntry = (entryId, position) => api("/playlist/" + encodeURIComponent(entryId), { method: "PATCH", body: JSON.stringify({ position }) });
  const clearPlaylist = () => api("/playlist", { method: "DELETE" });
  const getTop100 = () => api("/cache/top");
  const appleMusicImport = items => api("/apple-music/import", { method: "POST", body: JSON.stringify({ items }) });
  const clearAllData = password => api("/admin/clear-all", { method: "POST", body: JSON.stringify({ password }) });
  const searchAlbums = q => api("/albums/search?q=" + encodeURIComponent(q));
  const getStoredAlbums = () => api("/albums/stored");
  const getAlbum = id => api("/albums/" + encodeURIComponent(id));
  const acquireTrack = trackId => api(`/tracks/${encodeURIComponent(trackId)}/acquire`, { method: "POST" });
  const getJob = jobId => api("/jobs/" + encodeURIComponent(jobId));

  function fmtTime(s) { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; }
  function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c])); }

  const screenTitle = document.getElementById("screenTitle");
  const statusbar = document.getElementById("statusbar");
  const loginWrap = document.getElementById("loginWrap");
  const toastEl = document.getElementById("toast");
  const audio = document.getElementById("audio");
  let toastTimer = null;
  function toast(msg, ms = 1800) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms); }

  const views = {};
  document.querySelectorAll(".view").forEach(v => { views[v.id.replace("view-", "")] = v; });
  let stack = [];
  let playlistCache = [];
  function showView(key) { Object.values(views).forEach(v => v.classList.remove("active")); if (views[key]) views[key].classList.add("active"); }
  function current() { return stack[stack.length - 1]; }
  function push(screen) { stack.push(screen); renderCurrent(); }
  function pop() { if (stack.length <= 1) return; stack.pop(); renderCurrent(); }

  function renderCurrent() {
    const s = current(); if (!s) return;
    screenTitle.textContent = s.title || "iPod";
    showView(s.key);
    if (s.kind === "menu") renderMenu(s);
    if (s.kind === "nowplaying") renderNowPlaying();
  }

  function renderMenu(s) {
    const listEl = document.getElementById("list-" + s.key); if (!listEl) return;
    if (!s.items.length) { listEl.innerHTML = `<li class="empty" style="display:block;border:none;padding-top:40px;white-space:pre-line">${esc(s.emptyText || "Nothing here yet")}</li>`; return; }
    listEl.innerHTML = s.items.map((it, i) => `<li data-i="${i}" class="${i === s.selected ? "sel" : ""}">${it.html ? it.html : `<div class="l">${it.dot ? `<span class="dot ${it.dot}"></span>` : ""}<span class="name">${esc(it.label)}</span></div>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : `<span class="chev">${it.chev || (it.action ? "▸" : "")}</span>`}`}</li>`).join("");
    const sel = listEl.querySelector("li.sel"); if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    listEl.querySelectorAll("li[data-i]").forEach(li => li.addEventListener("click", e => { if (e.target.closest("[data-stop]")) return; s.selected = Number(li.dataset.i); renderMenu(s); selectCurrent(); }));
  }

  function moveSelection(delta) { const s = current(); if (!s || s.kind !== "menu" || !s.items.length) return; s.selected = Math.max(0, Math.min(s.items.length - 1, (s.selected || 0) + delta)); renderMenu(s); }
  function selectCurrent() { const s = current(); if (!s) return; if (s.kind === "menu") { const item = s.items[s.selected]; if (item?.action) item.action(); } else if (s.kind === "field") { if (s.onGo) s.onGo(); } else if (s.kind === "nowplaying") togglePlay(); }

  function openHome() {
    stack = [{ key: "home", title: "daksh music", kind: "menu", selected: 0, items: [
      { label: "Queue", action: () => window.__dakshOpenQueue?.() },
      { label: "Search", action: openSearch },
      { label: "Albums", action: openAlbums },
      { label: "Playlist", action: openPlaylist },
      { label: "Settings", action: openSettings },
    ] }];
    renderCurrent();
  }

  function openSettings() {
    push({ key: "settings", title: "Settings", kind: "menu", selected: 0, items: [
      { label: "Top 100", action: openTop100 },
      { label: "Import Apple Music", action: openAppleImport },
      { label: "Import Library CSV", action: openLibraryCsvImport },
      { label: "Export Playlist Excel", action: exportPlaylistExcel },
      { label: "Device Cache", action: openDeviceCache },
      { label: "Clear Playlist", action: async () => { if (!confirm("Clear the entire playlist? Cached audio is kept.")) return; try { await clearPlaylist(); toast("Playlist cleared"); } catch (e) { toast(e.message); } } },
      { label: "Clear All Data", action: openClearAllData },
      { label: "Log Out", action: async () => { await logout(); location.reload(); } },
    ] });
  }

  async function deviceCacheEntries() { if (!("caches" in window)) return []; try { const cache = await caches.open(DEVICE_CACHE_NAME); const keys = await cache.keys(); return keys.filter(r => !r.url.includes("__meta__")); } catch { return []; } }
  async function openDeviceCache() {
    const s = { key: "devicecache", title: "Device Cache", kind: "menu", selected: 0, items: [], emptyText: "" }; push(s);
    if (!("caches" in window)) { s.emptyText = "Your browser doesn't support on-device caching."; renderMenu(s); return; }
    const entries = await deviceCacheEntries();
    s.items = [{ label: `${entries.length} of ${DEVICE_CACHE_LIMIT} slots used`, sub: "Most recently played tracks are kept offline" }, { label: "Clear Device Cache", action: async () => { if (!confirm(`Remove ${entries.length} cached audio file(s) from this device?`)) return; try { await caches.delete(DEVICE_CACHE_NAME); toast("Device cache cleared"); await openDeviceCache(); } catch (e) { toast(e.message); } } }];
    renderMenu(s);
  }

  function playlistRowHtml(t, i, total) { return `<div class="l"><span class="name">${esc(t.title || "Untitled")}</span></div><span class="sub">${esc(t.artist || "")}</span><div class="row-actions" data-stop><button data-stop title="Move up" ${i===0?"disabled style='opacity:.3'":""} data-act="up">▲</button><button data-stop title="Move down" ${i===total-1?"disabled style='opacity:.3'":""} data-act="down">▼</button><button data-stop class="remove" title="Remove" data-act="remove">×</button></div>`; }
  function wirePlaylistRowActions(s, rows) { const listEl=document.getElementById("list-"+s.key); listEl.querySelectorAll("li[data-i]").forEach(li=>{const i=Number(li.dataset.i),row=rows[i];if(!row)return;const up=li.querySelector('[data-act="up"]'),down=li.querySelector('[data-act="down"]'),rm=li.querySelector('[data-act="remove"]');if(up)up.addEventListener("click",async e=>{e.stopPropagation();try{await moveEntry(row.entry_id,row.position-1);await openPlaylist();}catch(err){toast(err.message)}});if(down)down.addEventListener("click",async e=>{e.stopPropagation();try{await moveEntry(row.entry_id,row.position+1);await openPlaylist();}catch(err){toast(err.message)}});if(rm)rm.addEventListener("click",async e=>{e.stopPropagation();try{await removeFromPlaylist(row.entry_id);await openPlaylist();}catch(err){toast(err.message)}});}); }
  async function openPlaylist() { const s={key:"playlist",title:"Playlist",kind:"menu",selected:0,items:[],emptyText:"Playlist is empty.\nAdd songs from Search or Albums."};push(s);try{const rows=await getPlaylist();playlistCache=rows;s.items=rows.map((t,i)=>({html:playlistRowHtml(t,i,rows.length),action:()=>playTrack(t,rows,"playlist")}));renderMenu(s);wirePlaylistRowActions(s,rows);}catch(e){s.emptyText=e.message;renderMenu(s);} }

  async function openTop100() { const s={key:"top100",title:"Top 100",kind:"menu",selected:0,items:[],emptyText:"No play-count data yet."};push(s);try{const d=await getTop100();s.items=(d.items||[]).map(t=>({label:`${t.rank}. ${t.title||"Untitled"}`,sub:t.artist||"",dot:t.storage_key?"ready":"pending",action:()=>playTrack(t,null)}));}catch(e){s.emptyText=e.message;}renderMenu(s); }

  function openSearch() { push({key:"search",title:"Search",kind:"field",onGo:runSearch}); setTimeout(()=>document.getElementById("searchInput")?.focus(),50); }
  async function runSearch() { const q=document.getElementById("searchInput").value.trim(),status=document.getElementById("searchStatus"); if(!q){status.textContent="Type something to search.";return;} status.textContent="Searching…";try{const d=await searchTracks(q);status.textContent="";const s={key:"searchresults",title:"Results",kind:"menu",selected:0,items:[],emptyText:"No results."};s.items=(d.items||[]).map(it=>({label:it.title||"Untitled",sub:it.artist||"",action:async()=>{try{await window.__dakshSetQueue?.([it],0,"search");await window.__dakshQueue?.playCurrent?.();}catch(e){toast(e.message);}}}));push(s);}catch(e){status.textContent=e.message;} }

  function openAlbums() { push({key:"albumsmenu",title:"Albums",kind:"menu",selected:0,items:[{label:"Search Albums",action:openAlbumSearchField},{label:"Stored Albums",action:openStoredAlbums}]}); }
  function openAlbumSearchField() { push({key:"albums",title:"Search Albums",kind:"field",onGo:runAlbumSearch}); setTimeout(()=>document.getElementById("albumInput")?.focus(),50); }
  async function openStoredAlbums() { const s={key:"storedalbums",title:"Stored Albums",kind:"menu",selected:0,items:[],emptyText:"No albums cached yet."};push(s);try{const d=await getStoredAlbums();s.items=(d.items||[]).map(a=>({label:a.title||"Untitled Album",sub:`${a.artist||"Unknown artist"} · ${a.ready_tracks}/${a.total_tracks} ready`,action:()=>openAlbumDetail(a.album_id)}));}catch(e){s.emptyText=e.message;}renderMenu(s); }
  async function runAlbumSearch() { const q=document.getElementById("albumInput").value.trim(),status=document.getElementById("albumStatus");if(!q){status.textContent="Type an album or artist name.";return;}status.textContent="Searching…";try{const d=await searchAlbums(q);status.textContent="";const s={key:"albumresults",title:"Albums",kind:"menu",selected:0,items:[],emptyText:"No albums found."};s.items=(d.items||[]).map(al=>({label:al.title||"Untitled",sub:al.artist||"",action:()=>openAlbumDetail(al.album_id)}));push(s);}catch(e){status.textContent=e.message;} }
  async function openAlbumDetail(albumId) { const s={key:"albumdetail",title:"Album",kind:"menu",selected:0,items:[],emptyText:"Loading…"};push(s);try{const al=await getAlbum(albumId);s.title=al.title||"Album";const tracks=(al.tracks||[]).filter(t=>t.id!=null);s.items=[{label:"▸ Play Album",sub:`${tracks.length} track(s)`,action:async()=>{if(tracks.length){await window.__dakshSetQueue?.(tracks,0,"album");await window.__dakshQueue?.playCurrent?.();}}},...tracks.map(t=>({label:t.title||"Untitled",sub:fmtTime((t.duration_ms||0)/1000),action:async()=>{await window.__dakshSetQueue?.(tracks,tracks.findIndex(x=>String(x.id)===String(t.id)),"album");await window.__dakshQueue?.playCurrent?.();}}))];}catch(e){s.emptyText=e.message;s.items=[];}renderMenu(s); }

  let nowPlayingTrack=null, nowPlayingList=null, nowPlayingMode=null, overrideState=null;
  function nowPlayingScreen(){return {key:"nowplaying",title:"Now Playing",kind:"nowplaying"};}
  function setNpState(text){overrideState=text;renderNowPlayingStateOnly?.();}
  window.__dakshQueuePlayTrack=async(track,list,mode)=>{nowPlayingTrack=track;nowPlayingList=list;nowPlayingMode=mode;overrideState=null;if(current()?.key!=="nowplaying")push(nowPlayingScreen());else renderNowPlaying();const id=track.id??track.track_id;audio.src=`${API}/playback/${encodeURIComponent(id)}`;await audio.play().catch(()=>{});};
  window.__dakshNowPlayingTrackGetter=()=>nowPlayingTrack;

  function playTrack(track,listContext,mode=null){nowPlayingTrack=track;nowPlayingList=listContext;nowPlayingMode=mode;window.__dakshQueuePlayTrack(track,listContext,mode);}

  async function runClearAllData(){const pwEl=document.getElementById("clearAllPassword"),status=document.getElementById("clearAllStatus"),password=pwEl?.value?.trim()||"";if(!status)return;if(!password){status.textContent="Enter your password to confirm.";return;}const button=document.getElementById("clearAllGo");if(button?.dataset.busy==="1")return;if(button){button.dataset.busy="1";button.disabled=true;}status.textContent="Clearing all data…";try{const res=await clearAllData(password);if(pwEl)pwEl.value="";status.textContent=`Cleared. Removed ${Number(res.r2_objects_deleted||0)} cached audio file(s).`;nowPlayingTrack=null;audio.pause();audio.removeAttribute("src");toast("All data cleared");}catch(e){status.textContent=e?.message||"Clear All Data failed.";}finally{if(button){button.dataset.busy="0";button.disabled=false;}}}
  function openClearAllData(){push({key:"clearall",title:"Clear All Data",kind:"field",onGo:runClearAllData});setTimeout(()=>{const input=document.getElementById("clearAllPassword");input?.focus();const button=document.getElementById("clearAllGo");if(button&&!button.dataset.appBound){button.dataset.appBound="1";button.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();runClearAllData();});}input?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();e.stopPropagation();runClearAllData();}});},0);}

  function openAppleImport(){push({key:"appleimport",title:"Apple Music",kind:"field",onGo:runAppleImport});}
  function playlistUrlId(url){try{const u=new URL(url),parts=u.pathname.split("/").filter(Boolean);return parts[parts.length-1]||null;}catch{return null;}}
  async function appleFetch(url,developerToken,userToken){const r=await fetch(url,{headers:{Authorization:`Bearer ${developerToken}`,"Music-User-Token":userToken}});const text=await r.text();if(!r.ok)throw new Error(`Apple Music API ${r.status}: ${text.slice(0,200)}`);return JSON.parse(text);}
  async function findLibraryPlaylist(developerToken,userToken,inputUrl){const wanted=playlistUrlId(inputUrl);let next="https://api.music.apple.com/v1/me/library/playlists?limit=100";while(next){const d=await appleFetch(next,developerToken,userToken);for(const p of d.data||[])if(wanted&&(String(p.id)===String(wanted)||p.attributes?.url===inputUrl))return p;next=d.next?(d.next.startsWith("http")?d.next:`https://api.music.apple.com${d.next}`):null;}return null;}
  async function runAppleImport(){const status=document.getElementById("appleStatus"),developerToken=document.getElementById("appleDevToken").value.trim(),inputUrl=document.getElementById("applePlaylistUrl").value.trim();if(!developerToken||!inputUrl){status.textContent="Enter a developer token and playlist URL.";return;}try{status.textContent="Authorizing Apple Music…";if(!window.MusicKit)throw new Error("MusicKit JS did not load");MusicKit.configure({developerToken,app:{name:"daksh music",build:"1.0"}});const music=MusicKit.getInstance(),userToken=await music.authorize();status.textContent="Finding your library playlist…";const playlist=await findLibraryPlaylist(developerToken,userToken,inputUrl);if(!playlist)throw new Error("Playlist not found. Add it to your library first.");let next=`https://api.music.apple.com/v1/me/library/playlists/${encodeURIComponent(playlist.id)}/tracks?limit=100`,items=[];while(next){const d=await appleFetch(next,developerToken,userToken);for(const x of d.data||[]){const a=x.attributes||{};items.push({title:a.name,artist:a.artistName||"",album:a.albumName||null,play_count:Number(a.playCount||0)});}next=d.next?(d.next.startsWith("http")?d.next:`https://api.music.apple.com${d.next}`):null;}if(!items.length)throw new Error("No tracks found in that playlist.");status.textContent=`Sending ${items.length} tracks…`;const result=await appleMusicImport(items);status.textContent=`Imported ${result.imported}. ${result.unmatched?.length||0} unmatched.`;toast("Top 100 updated");}catch(e){status.textContent=e.message;} }

  function openLogin(){ loginWrap.classList.remove("hidden"); statusbar.style.display="none"; }
  function showLoggedIn(){ loginWrap.classList.add("hidden"); statusbar.style.display="flex"; openHome(); }
  document.getElementById("loginBtn")?.addEventListener("click",async()=>{const p=document.getElementById("password").value,err=document.getElementById("loginErr");try{await login(p);err.textContent="";showLoggedIn();}catch(e){err.textContent=e.message;}});
  document.getElementById("password")?.addEventListener("keydown",e=>{if(e.key==="Enter")document.getElementById("loginBtn")?.click();});
  document.addEventListener("click",e=>{const button=e.target?.closest?.("#clearAllGo");if(!button||button.dataset.appDelegated==="1")return;button.dataset.appDelegated="1";e.preventDefault();e.stopPropagation();runClearAllData();});
  document.getElementById("btnMenu")?.addEventListener("click",()=>pop());
  document.getElementById("btnCenter")?.addEventListener("click",()=>selectCurrent());
  document.getElementById("btnPrev")?.addEventListener("click",()=>{ if(window.__dakshQueue?.previous) window.__dakshQueue.previous(); });
  document.getElementById("btnNext")?.addEventListener("click",()=>{ if(window.__dakshQueue?.next) window.__dakshQueue.next(); });
  document.getElementById("btnPlay")?.addEventListener("click",()=>audio.paused?audio.play():audio.pause());

  openLogin();
})();