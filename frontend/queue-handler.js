(() => {
  const API="/api/v1", QUEUE_API="/api/v1/playback-queue", QUEUE_KEY="daksh-queue-v4", cacheName="device-audio-v1";
  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  async function api(path,options={}){const r=await fetch(path.startsWith("/api/")?path:API+path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{};}catch{}if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;}
  let state={items:[],current_index:-1,mode:"manual"};
  function persist(){try{localStorage.setItem(QUEUE_KEY,JSON.stringify(state));}catch{}}
  async function sync(){try{const d=await api(QUEUE_API);state={items:d.items||[],current_index:Number.isInteger(d.current_index)?d.current_index:-1,mode:d.mode||"manual"};persist();}catch{try{const x=JSON.parse(localStorage.getItem(QUEUE_KEY)||"null");if(x?.items)state=x;}catch{}}return state;}
  async function replace(items,current=0,mode="manual"){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));const d=await api(QUEUE_API,{method:"POST",body:JSON.stringify({mode:"replace",items:clean,current_index:clean.length?current:-1,playback_mode:mode})});state={items:d.items||clean,current_index:Number.isInteger(d.current_index)?d.current_index:(clean.length?current:-1),mode:d.mode||mode};persist();return state;}
  async function append(items){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));if(!clean.length)return state;const d=await api(QUEUE_API,{method:"POST",body:JSON.stringify({mode:"append",items:clean})});state={...state,items:d.items||state.items,current_index:Number.isInteger(d.current_index)?d.current_index:state.current_index,mode:d.mode||state.mode};persist();return state;}
  async function clear(){await api(QUEUE_API,{method:"DELETE"});state={items:[],current_index:-1,mode:"manual"};persist();}
  async function setCurrent(index){const d=await api(`${QUEUE_API}/current`,{method:"POST",body:JSON.stringify({index})});state={...state,current_index:d.current_index};persist();return state.items[state.current_index]||null;}
  async function remove(index){const d=await api(`${QUEUE_API}/${encodeURIComponent(index)}`,{method:"DELETE"});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function reorder(from,to){const d=await api(`${QUEUE_API}/reorder`,{method:"POST",body:JSON.stringify({from,to})});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function deviceCached(id){if(!( "caches"in window)||id==null)return false;try{const c=await caches.open(cacheName);return !!await c.match(`${location.origin}${API}/playback/${encodeURIComponent(id)}`);}catch{return false;}}
  async function cacheFlags(items){return Promise.all(items.map(async t=>({...t,device_cached:await deviceCached(t.track_id??t.id)})));}
  function showNowPlaying(track){window.__dakshNowPlayingTrack=track;document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));document.getElementById("view-nowplaying")?.classList.add("active");const title=document.getElementById("screenTitle");if(title)title.textContent="Now Playing";const nt=document.getElementById("npTitle");if(nt)nt.textContent=track?.title||"Untitled";const ns=document.getElementById("npSub");if(ns)ns.textContent=[track?.artist,track?.album].filter(Boolean).join(" — ")||"—";const art=document.getElementById("npArt");if(art)art.innerHTML=track?.artwork_url?`<img src="${esc(track.artwork_url)}" alt="">`:``;const audio=document.getElementById("audio");if(audio){audio.src=`${API}/playback/${encodeURIComponent(track.id??track.track_id)}`;audio.play().catch(()=>{});}}
  async function playIndex(index){if(index<0||index>=state.items.length)return;await setCurrent(index);showNowPlaying(state.items[index]);}
  async function next(){if(state.current_index+1<state.items.length)return playIndex(state.current_index+1);}
  async function previous(){if(state.current_index>0)return playIndex(state.current_index-1);}
  function sourceLabel(t){return t.queue_source||({album:"Album",playlist:"Playlist",search:"Search"}[state.mode]||"Server Queue");}
  async function renderOverlay(){let o=document.getElementById("dakshQueueOverlay");if(!o){o=document.createElement("div");o.id="dakshQueueOverlay";o.innerHTML=`<div class="dq-head"><div><b>Queue</b><small id="dqSource"></small></div><button id="dqClose">MENU</button></div><div id="dqLegend"><span><i class="dq-dot device"></i> On device</span><span><i class="dq-dot server"></i> Server</span></div><div id="dqBody"></div><div class="dq-foot"><button id="dqClear">Clear</button></div>`;document.getElementById("screen")?.appendChild(o);document.getElementById("dqClose").onclick=()=>o.remove();document.getElementById("dqClear").onclick=async()=>{if(confirm("Clear the queue?")){await clear();renderOverlay();}};}const body=document.getElementById("dqBody");const items=await cacheFlags(state.items);document.getElementById("dqSource").textContent=state.items.length?` · ${sourceLabel(state.items[0])}`:"";body.innerHTML=items.length?items.map((t,i)=>{const source=sourceLabel(t);return `<div class="dq-row ${i===state.current_index?"cur":""} ${t.device_cached?"device-ready":""}" data-i="${i}"><div class="dq-main"><span class="dq-pos">${i+1}</span><div class="dq-text"><b>${esc(t.title||"Untitled")}</b><small>${esc(t.artist||"")}${t.album?` · ${esc(t.album)}`:""}</small><div class="dq-badges"><span class="dq-badge server">${esc(source)}</span>${t.server_available?`<span class="dq-badge server">CACHED</span>`:""}${t.device_cached?`<span class="dq-badge device">ON DEVICE</span>`:""}</div></div></div><span class="dq-state">${t.device_cached?"Ready offline":""}</span></div>`;}).join(""):`<div class="dq-empty">Queue is empty</div>`;body.querySelectorAll(".dq-row").forEach(row=>row.onclick=()=>playIndex(Number(row.dataset.i)));}
  function openQueue(){sync().then(renderOverlay);}
  window.__dakshQueue={sync,replace,append,clear,remove,reorder,setCurrent,next,previous,get state(){return state;},deviceCached};
  window.__dakshOpenQueue=openQueue;window.__dakshSetQueue=replace;
  window.__setPlaylistSearchQueue=async tracks=>{const clean=Array.isArray(tracks)?tracks.filter(Boolean):[];if(!clean.length)return;await sync();if(state.items.length&&!confirm(`Replace the current queue with ${clean.length} search result${clean.length===1?"":"s"}?`))return;await replace(clean,0,"search");showNowPlaying(state.items[0]);};
  window.__dakshQueuePlay=showNowPlaying;
  document.getElementById("audio")?.addEventListener("ended",()=>next());
  window.addEventListener("keydown",e=>{if(e.key==="ArrowRight"&&document.activeElement?.tagName!=="INPUT")next();if(e.key==="ArrowLeft"&&document.activeElement?.tagName!=="INPUT")previous();});

  // app.js has a legacy lexical openQueue() which reads /playlist. Because
  // that function is not replaceable from another script, intercept every
  // possible Home -> Queue activation before app.js receives it: mouse/touch
  // clicks on the row, the wheel center button, and keyboard Enter.
  function homeQueueSelected(){
    const row=document.querySelector("#list-home li.sel");
    return row?.querySelector(".name")?.textContent?.trim()==="Queue";
  }
  function interceptQueueActivation(e){
    if(!homeQueueSelected())return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openQueue();
  }
  document.addEventListener("click",e=>{
    const li=e.target.closest?.("#list-home li");
    if(li?.querySelector(".name")?.textContent?.trim()==="Queue")interceptQueueActivation(e);
  },true);
  document.addEventListener("click",e=>{
    if(e.target.closest?.("#btnCenter")&&homeQueueSelected())interceptQueueActivation(e);
  },true);
  document.addEventListener("keydown",e=>{
    if((e.key==="Enter"||e.key===" ")&&homeQueueSelected())interceptQueueActivation(e);
  },true);

  const style=document.createElement("style");style.textContent=`#dakshQueueOverlay{position:absolute;inset:22px 0 0;background:linear-gradient(180deg,var(--screen-top),var(--screen-bg));z-index:30;color:var(--screen-ink);display:flex;flex-direction:column}.dq-head{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border-bottom:1px solid rgba(0,0,0,.12);font-size:11px}.dq-head small{font-size:8px;color:var(--screen-sub);margin-left:4px}.dq-head button,.dq-foot button{border:0;background:transparent;color:var(--screen-sub);font-size:9px;font-weight:700}#dqLegend{display:flex;gap:10px;padding:4px 8px;font-size:8px;color:var(--screen-sub);border-bottom:1px solid rgba(0,0,0,.06)}.dq-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px}.dq-dot.device{background:#3f9e4d}.dq-dot.server{background:var(--accent)}#dqBody{overflow:auto;min-height:0;flex:1}.dq-row{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,.06);cursor:pointer}.dq-row.cur{background:linear-gradient(180deg,var(--sel-a),var(--sel-b));color:#fff}.dq-row.device-ready{box-shadow:inset 3px 0 0 #3f9e4d}.dq-main{display:flex;gap:6px;min-width:0}.dq-pos{width:14px;flex:none;text-align:right;font-size:8px;color:var(--screen-sub)}.dq-row.cur .dq-pos,.dq-row.cur small,.dq-row.cur .dq-state{color:#dbe6f5}.dq-text{min-width:0}.dq-text b,.dq-text small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dq-text b{font-size:9.5px}.dq-text small{font-size:8px;color:var(--screen-sub)}.dq-badges{display:flex;gap:3px;margin-top:2px}.dq-badge{display:inline-block;padding:1px 3px;border-radius:3px;font-size:6.5px;font-weight:800;letter-spacing:.04em}.dq-badge.device{background:#dcefdc;color:#286c31}.dq-badge.server{background:#dbe7f6;color:#2f5f97}.dq-row.cur .dq-badge.device{background:#c8e8cc;color:#205b28}.dq-row.cur .dq-badge.server{background:#c6d8ef;color:#234c79}.dq-state{font-size:7px;color:#3f7d47;flex:none}.dq-empty{padding:30px;text-align:center;font-size:10px;color:var(--screen-sub)}.dq-foot{margin-top:auto;padding:5px 9px;border-top:1px solid rgba(0,0,0,.08);text-align:right}`;document.head.appendChild(style);
  sync();
})();
