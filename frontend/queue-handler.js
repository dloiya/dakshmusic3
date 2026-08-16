(() => {
  const API = "/api/v1";
  const QUEUE_KEY = "daksh-queue-v2";
  const cacheName = "device-audio-v1";
  const esc = v => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  async function api(path, options = {}) {
    const r = await fetch(API + path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const text = await r.text(); let d = {};
    try { d = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }
  let state = { items: [], current_index: -1, mode: "manual" };
  function persist() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state)); } catch {} }
  async function sync() {
    try { const d = await api("/queue"); state = { items:d.items||[], current_index:Number.isInteger(d.current_index)?d.current_index:-1, mode:d.mode||"manual" }; persist(); }
    catch { try { const x=JSON.parse(localStorage.getItem(QUEUE_KEY)||"null"); if(x?.items) state=x; } catch {} }
    return state;
  }
  async function replace(items, current=0, mode="manual") {
    const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));
    const d=await api("/queue",{method:"POST",body:JSON.stringify({mode:"replace",items:clean,current_index:clean.length?current:-1,playback_mode:mode})});
    state={items:d.items||clean,current_index:Number.isInteger(d.current_index)?d.current_index:(clean.length?current:-1),mode:d.mode||mode};persist();return state;
  }
  async function append(items) {
    const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null)); if(!clean.length)return state;
    const d=await api("/queue",{method:"POST",body:JSON.stringify({mode:"append",items:clean})});
    state={...state,items:d.items||state.items,current_index:Number.isInteger(d.current_index)?d.current_index:state.current_index,mode:d.mode||state.mode};persist();return state;
  }
  async function clear(){await api("/queue",{method:"DELETE"});state={items:[],current_index:-1,mode:"manual"};persist();}
  async function setCurrent(index){const d=await api("/queue/current",{method:"POST",body:JSON.stringify({index})});state={...state,current_index:d.current_index};persist();return state.items[state.current_index]||null;}
  async function remove(index){const d=await api(`/queue/${encodeURIComponent(index)}`,{method:"DELETE"});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function reorder(from,to){const d=await api("/queue/reorder",{method:"POST",body:JSON.stringify({from,to})});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function deviceCached(id){if(!("caches"in window)||id==null)return false;try{const c=await caches.open(cacheName);return !!await c.match(`${location.origin}${API}/playback/${encodeURIComponent(id)}`);}catch{return false;}}
  function goExistingQueue(){const home=document.getElementById("list-home");const li=home&&[...home.querySelectorAll("li")].find(x=>(x.textContent||"").trim().startsWith("Queue"));if(li){li.click();return true;}return false;}
  function openQueue(){if(!goExistingQueue())renderOverlay();}
  function renderOverlay(){let o=document.getElementById("dakshQueueOverlay");if(!o){o=document.createElement("div");o.id="dakshQueueOverlay";o.innerHTML=`<div class="dq-head"><b>Queue</b><button id="dqClose">MENU</button></div><div id="dqBody"></div><div class="dq-foot"><button id="dqClear">Clear</button></div>`;document.getElementById("screen")?.appendChild(o);document.getElementById("dqClose").onclick=()=>o.remove();document.getElementById("dqClear").onclick=async()=>{if(confirm("Clear the queue?")){await clear();renderOverlay();}};}const body=document.getElementById("dqBody");body.innerHTML=state.items.length?state.items.map((t,i)=>`<div class="dq-row ${i===state.current_index?"cur":""}" data-i="${i}"><span>${esc(t.title||"Untitled")}</span><small>${esc(t.artist||"")}</small></div>`).join(""):`<div class="dq-empty">Queue is empty</div>`;body.querySelectorAll(".dq-row").forEach(row=>row.onclick=async()=>{const i=Number(row.dataset.i);await setCurrent(i);window.__dakshQueuePlay?.(state.items[i]);renderOverlay();});}
  window.__dakshQueue={sync,replace,append,clear,remove,reorder,setCurrent,get state(){return state;},deviceCached};
  window.__dakshOpenQueue=openQueue;
  window.__dakshSetQueue=replace;
  window.__setPlaylistSearchQueue=async tracks=>{const clean=Array.isArray(tracks)?tracks.filter(Boolean):[];if(!clean.length)return;await sync();if(state.items.length&&!confirm(`Replace the current queue with ${clean.length} search result${clean.length===1?"":"s"}?`))return;await replace(clean,0,"search");window.__dakshQueuePlay?.(clean[0]);};
  window.__dakshQueuePlay=track=>{if(!track)return;window.__dakshNowPlayingTrack=track;window.dispatchEvent(new CustomEvent("daksh-queue-play",{detail:track}));};
  sync();
})();