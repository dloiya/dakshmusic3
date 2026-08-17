(() => {
  const API = "/api/v1";
  const QUEUE_API = "/api/v1/playback-queue";
  const QUEUE_KEY = "daksh-queue-v15";
  const CACHE_NAME = "device-audio-v1";
  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;"," ":">","\"":"&quot;","'":"&#039;"}[c] || c));
  const nativeFetch = window.fetch.bind(window);
  let playlistResponseCache = null;
  let playlistCachePromise = null;
  const invalidatePlaylistCache = () => { playlistResponseCache = null; playlistCachePromise = null; };
  window.fetch = async (input, init = {}) => {
    const reqUrl = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
    let parsed; try { parsed = new URL(reqUrl, location.origin); } catch { parsed = null; }
    const isPlaylistGet = parsed?.pathname === `${API}/playlist` && method === "GET";
    if (parsed?.pathname === `${API}/playlist` && method !== "GET") invalidatePlaylistCache();
    if (!isPlaylistGet) return nativeFetch(input, init);
    if (playlistResponseCache) return playlistResponseCache.clone();
    if (playlistCachePromise) return (await playlistCachePromise).clone();
    playlistCachePromise = nativeFetch(input, init).then(r => { if (r.ok) playlistResponseCache = r.clone(); return r; }).finally(() => { playlistCachePromise = null; });
    return (await playlistCachePromise).clone();
  };
  async function api(path, options = {}) { const res = await nativeFetch(path, { credentials:"include", ...options, headers:{"Content-Type":"application/json", ...(options.headers||{})} }); const text = await res.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{} if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`); return data; }
  let state={items:[],current_index:-1,mode:"manual"};
  const persist=()=>{try{localStorage.setItem(QUEUE_KEY,JSON.stringify(state));}catch{}};
  const apply=(d,fallback={})=>{state={items:Array.isArray(d?.items)?d.items:(fallback.items||[]),current_index:Number.isInteger(d?.current_index)?d.current_index:(fallback.current_index??-1),mode:d?.mode||fallback.mode||"manual"};persist();return state;};
  async function sync(){return apply(await api(QUEUE_API));}
  async function replace(items,current=0,mode="manual",sourceTrackId=null){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));const idx=clean.length?Math.max(0,Math.min(Number(current)||0,clean.length-1)):-1;return apply(await api(QUEUE_API,{method:"POST",body:JSON.stringify({mode:"replace",items:clean,current_index:idx,playback_mode:mode,source_track_id:sourceTrackId})}),{items:clean,current_index:idx,mode});}
  async function append(items){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));if(!clean.length)return state;return apply(await api(QUEUE_API,{method:"POST",body:JSON.stringify({mode:"append",items:clean})}),state);}
  async function clear(){return apply(await api(QUEUE_API,{method:"DELETE"}));}
  async function setCurrent(index){return apply(await api(`${QUEUE_API}/current`,{method:"POST",body:JSON.stringify({index})}),state);}
  async function remove(index){return apply(await api(`${QUEUE_API}/${encodeURIComponent(index)}`,{method:"DELETE"}),state);}
  async function reorder(from,to){return apply(await api(`${QUEUE_API}/reorder`,{method:"POST",body:JSON.stringify({from,to})}),state);}
  async function deviceCached(id){if(!("caches"in window)||id==null)return false;try{const c=await caches.open(CACHE_NAME);return!!await c.match(`${location.origin}${API}/playback/${encodeURIComponent(id)}`);}catch{return false;}}
  async function cacheFlags(items){return Promise.all(items.map(async t=>({...t,device_cached:await deviceCached(t.track_id??t.id)})));}
  async function playIndex(index){if(index<0||index>=state.items.length)return null;const d=await setCurrent(index);const track=d.items[d.current_index];if(!track)return null;window.__dakshNowPlayingTrack=track;window.__dakshNowPlayingQueueIndex=d.current_index;await playTrackDirect(track,d.items,d.mode);return track;}
  async function playCurrent(){if(!state.items.length)return null;let index=state.current_index;if(!Number.isInteger(index)||index<0||index>=state.items.length)index=0;return playIndex(index);}
  async function next(){try{await sync();}catch{}return state.current_index+1<state.items.length?playIndex(state.current_index+1):null;}
  async function previous(){try{await sync();}catch{}return state.current_index>0?playIndex(state.current_index-1):null;}
  function sameQueue(items){if(!Array.isArray(items)||items.length!==state.items.length)return false;return items.every((x,i)=>String(x.id??x.track_id)===String(state.items[i].id??state.items[i].track_id));}
  async function ensureSourceQueue(track,list,mode){
    if(!Array.isArray(list)||!list.length)return state;
    const id=String(track?.id??track?.track_id);
    const index=list.findIndex(x=>String(x?.id??x?.track_id)===id);
    if(index<0)return state;
    if(mode==="playlist"||mode==="album"){
      // Once the server has positioned the source queue, navigation passes that
      // already-positioned queue back in. Do NOT re-slice/rewrite it.
      if(sameQueue(list)&&state.mode===mode)return state;
      // Initial source selection: send the complete source and selected ID.
      // The server trims it to selected track -> end, preserving the full
      // remaining queue (e.g. exactly 35 songs when 35 remain).
      return replace(list,index,mode,track?.id??track?.track_id);
    }
    if(!sameQueue(list)||state.mode!==mode||state.current_index!==index)return replace(list,index,mode||"manual");
    return state;
  }
  async function playTrackDirect(track,list,mode){const queued=await ensureSourceQueue(track,list,mode);const actualTrack=(mode==="playlist"||mode==="album")&&queued.items.length?queued.items[queued.current_index>=0?queued.current_index:0]:track;const id=actualTrack?.id??actualTrack?.track_id;if(id==null)throw new Error("Track has no ID");try{await api(`/tracks/${encodeURIComponent(id)}/acquire`,{method:"POST"});}catch{}const audio=document.getElementById("audio");if(!audio)throw new Error("Audio player unavailable");audio.src=`${API}/playback/${encodeURIComponent(id)}`;await audio.play();return queued;}
  function sourceLabel(){return state.mode==="album"?"Album":state.mode==="playlist"?"Playlist":state.mode==="search"?"Search":"Queue";}
  async function renderOverlay(){let overlay=document.getElementById("dakshQueueOverlay");if(!overlay){overlay=document.createElement("div");overlay.id="dakshQueueOverlay";overlay.innerHTML=`<div class="dq-head"><button id="dqBack" class="dq-back" title="Back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/><path d="M9 12h11"/></svg></button><div class="dq-title"><b>Queue</b><small id="dqSource"></small></div></div><div id="dqBody"></div><div class="dq-foot"><button id="dqClear">Clear</button></div>`;document.getElementById("screen")?.appendChild(overlay);overlay.querySelector("#dqBack").onclick=()=>{overlay.remove();document.getElementById("btnMenu")?.click();};overlay.querySelector("#dqClear").onclick=async()=>{if(confirm("Clear the queue?")){await clear();await renderOverlay();}};}const body=overlay.querySelector("#dqBody");const items=await cacheFlags(state.items);overlay.querySelector("#dqSource").textContent=state.items.length?` · ${sourceLabel()}`:"";body.innerHTML=items.length?items.map((t,i)=>`<div class="dq-row ${i===state.current_index?"cur":""} ${t.device_cached?"device-ready":""}" data-i="${i}"><div class="dq-main"><span class="dq-pos">${i+1}</span><div class="dq-text"><b>${esc(t.title||"Untitled")}</b><small>${esc(t.artist||"")}${t.album?` · ${esc(t.album)}`:""}</small><div class="dq-badges">${t.server_available?`<span class="dq-badge server">SERVER</span>`:""}${t.device_cached?`<span class="dq-badge device">ON DEVICE</span>`:""}</div></div></div><span class="dq-state">${t.device_cached?"Ready offline":""}</span></div>`).join(""): `<div class="dq-empty">Queue is empty</div>`;body.querySelectorAll(".dq-row").forEach(row=>row.onclick=()=>playIndex(Number(row.dataset.i)));}
  async function openQueue(){document.getElementById("dakshQueueOverlay")?.remove();try{await sync();await renderOverlay();}catch(e){const screen=document.getElementById("screen");if(screen){const error=document.createElement("div");error.id="dakshQueueOverlay";error.className="dq-error";error.innerHTML=`<button id="dqBackError" class="dq-back" title="Back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/><path d="M9 12h11"/></svg></button><span>${esc(`Queue unavailable: ${e.message}`)}</span>`;error.querySelector("#dqBackError").onclick=()=>{error.remove();document.getElementById("btnMenu")?.click();};screen.appendChild(error);}}}
  async function syncCurrentFromTrack(track){const id=track?.id??track?.track_id;if(id==null)return;const index=state.items.findIndex(x=>String(x.id??x.track_id)===String(id));if(index>=0&&index!==state.current_index)await setCurrent(index);}
  const queuePlayTrack=async(track,list,mode)=>{if(!Array.isArray(list)||!list.length){if(!state.items.length)await sync();return playTrackDirect(track,state.items,state.mode);}return playTrackDirect(track,list,mode||"manual");};
  try{Object.defineProperty(window,"__dakshQueuePlayTrack",{configurable:false,enumerable:true,get:()=>queuePlayTrack,set:()=>{}});}catch{window.__dakshQueuePlayTrack=queuePlayTrack;}
  window.__dakshQueue={sync,replace,append,clear,remove,reorder,setCurrent,playIndex,playCurrent,next,previous,get state(){return state;},deviceCached};window.__dakshOpenQueue=openQueue;window.__dakshSetQueue=replace;window.__dakshQueueSyncCurrent=syncCurrentFromTrack;window.__dakshQueuePlay=playIndex;
  const audio=document.getElementById("audio");audio?.addEventListener("ended",()=>{next().catch(()=>{});});
  const style=document.createElement("style");style.textContent=`#dakshQueueOverlay{position:absolute;inset:22px 0 0;background:linear-gradient(180deg,var(--screen-top),var(--screen-bg));z-index:30;color:var(--screen-ink);display:flex;flex-direction:column}.dq-head{display:flex;align-items:center;gap:7px;padding:5px 7px;border-bottom:1px solid rgba(0,0,0,.12);font-size:11px}.dq-back{border:0;background:transparent;color:var(--screen-sub);width:24px;height:24px;padding:3px;display:flex;align-items:center;justify-content:center;cursor:pointer}.dq-back svg{width:17px;height:17px}.dq-back:hover{color:var(--screen-ink)}.dq-title{display:flex;align-items:baseline;gap:3px}.dq-head small{font-size:8px;color:var(--screen-sub)}#dqBody{overflow:auto;min-height:0;flex:1}.dq-row{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,.06);cursor:pointer}.dq-row.cur{background:linear-gradient(180deg,var(--sel-a),var(--sel-b));color:#fff}.dq-row.device-ready{box-shadow:inset 3px 0 0 #3f9e4d}.dq-main{display:flex;gap:6px;min-width:0}.dq-pos{width:14px;flex:none;text-align:right;font-size:8px;color:var(--screen-sub)}.dq-row.cur .dq-pos,.dq-row.cur small,.dq-row.cur .dq-state{color:#dbe6f5}.dq-text{min-width:0}.dq-text b,.dq-text small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dq-text b{font-size:9.5px}.dq-text small{font-size:8px;color:var(--screen-sub)}.dq-badges{display:flex;gap:3px;margin-top:2px}.dq-badge{display:inline-block;padding:1px 3px;border-radius:3px;font-size:6.5px;font-weight:800;letter-spacing:.04em}.dq-badge.device{background:#dcefdc;color:#286c31}.dq-badge.server{background:#dbe7f6;color:#2f5f97}.dq-row.cur .dq-badge.device{background:#c8e8cc;color:#205b28}.dq-row.cur .dq-badge.server{background:#c6d8ef;color:#234c79}.dq-state{font-size:7px;color:#3f7d47;flex:none}.dq-empty,.dq-error{padding:30px;text-align:center;font-size:10px;color:var(--screen-sub)}.dq-error{position:absolute;inset:22px 0 0;background:var(--screen-bg);z-index:30}.dq-error .dq-back{position:absolute;left:5px;top:4px}.dq-error span{display:block}`;document.head.appendChild(style);
})();
