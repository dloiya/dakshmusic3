(() => {
  const API="/api/v1", QUEUE_KEY="daksh-queue-v2", cacheName="device-audio-v1";
  const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#039;"}[c]));
  async function api(path,options={}){const r=await fetch(API+path,{credentials:"include",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{};}catch{}if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;}
  let state={items:[],current_index:-1,mode:"manual"};
  function persist(){try{localStorage.setItem(QUEUE_KEY,JSON.stringify(state));}catch{}}
  async function sync(){try{const d=await api("/queue");state={items:d.items||[],current_index:Number.isInteger(d.current_index)?d.current_index:-1,mode:d.mode||"manual"};persist();}catch{try{const x=JSON.parse(localStorage.getItem(QUEUE_KEY)||"null");if(x?.items)state=x;}catch{}}return state;}
  async function replace(items,current=0,mode="manual"){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));const d=await api("/queue",{method:"POST",body:JSON.stringify({mode:"replace",items:clean,current_index:clean.length?current:-1,playback_mode:mode})});state={items:d.items||clean,current_index:Number.isInteger(d.current_index)?d.current_index:(clean.length?current:-1),mode:d.mode||mode};persist();return state;}
  async function append(items){const clean=(items||[]).filter(x=>x&&(x.id!=null||x.track_id!=null));if(!clean.length)return state;const d=await api("/queue",{method:"POST",body:JSON.stringify({mode:"append",items:clean})});state={...state,items:d.items||state.items,current_index:Number.isInteger(d.current_index)?d.current_index:state.current_index,mode:d.mode||state.mode};persist();return state;}
  async function clear(){await api("/queue",{method:"DELETE"});state={items:[],current_index:-1,mode:"manual"};persist();}
  async function setCurrent(index){const d=await api("/queue/current",{method:"POST",body:JSON.stringify({index})});state={...state,current_index:d.current_index};persist();return state.items[state.current_index]||null;}
  async function remove(index){const d=await api(`/queue/${encodeURIComponent(index)}`,{method:"DELETE"});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function reorder(from,to){const d=await api("/queue/reorder",{method:"POST",body:JSON.stringify({from,to})});state={...state,items:d.items||[],current_index:d.current_index??-1};persist();}
  async function deviceCached(id){if(!( "caches" in window)||id==null)return false;try{const c=await caches.open(cacheName);return !!await c.match(`${location.origin}${API}/playback/${encodeURIComponent(id)}`);}catch{return false;}}

  function showNowPlaying(track){
    window.__dakshNowPlayingTrack=track;
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById("view-nowplaying")?.classList.add("active");
    const title=document.getElementById("screenTitle");if(title)title.textContent="Now Playing";
    const nt=document.getElementById("npTitle");if(nt)nt.textContent=track?.title||"Untitled";
    const ns=document.getElementById("npSub");if(ns)ns.textContent=[track?.artist,track?.album].filter(Boolean).join(" — ")||"—";
    const art=document.getElementById("npArt");if(art)art.innerHTML=track?.artwork_url?`<img src="${esc(track.artwork_url)}" alt="">`:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    const audio=document.getElementById("audio");if(audio){audio.src=`${API}/playback/${encodeURIComponent(track.id??track.track_id)}`;audio.play().catch(()=>{});}
  }
  async function playIndex(index){if(index<0||index>=state.items.length)return;await setCurrent(index);showNowPlaying(state.items[index]);}
  async function next(){if(state.current_index+1<state.items.length)return playIndex(state.current_index+1);}
  async function previous(){if(state.current_index>0)return playIndex(state.current_index-1);}

  function renderOverlay(){let o=document.getElementById("dakshQueueOverlay");if(!o){o=document.createElement("div");o.id="dakshQueueOverlay";o.innerHTML=`<div class="dq-head"><b>Queue</b><button id="dqClose">MENU</button></div><div id="dqBody"></div><div class="dq-foot"><button id="dqClear">Clear</button></div>`;document.getElementById("screen")?.appendChild(o);document.getElementById("dqClose").onclick=()=>o.remove();document.getElementById("dqClear").onclick=async()=>{if(confirm("Clear the queue?")){await clear();renderOverlay();}};}const body=document.getElementById("dqBody");body.innerHTML=state.items.length?state.items.map((t,i)=>`<div class="dq-row ${i===state.current_index?"cur":""}" data-i="${i}"><span>${esc(t.title||"Untitled")}</span><small>${esc(t.artist||"")}</small></div>`).join(""):`<div class="dq-empty">Queue is empty</div>`;body.querySelectorAll(".dq-row").forEach(row=>row.onclick=()=>playIndex(Number(row.dataset.i)));}
  function openQueue(){renderOverlay();}

  window.__dakshQueue={sync,replace,append,clear,remove,reorder,setCurrent,next,previous,get state(){return state;},deviceCached};
  window.__dakshOpenQueue=openQueue;window.__dakshSetQueue=replace;
  window.__setPlaylistSearchQueue=async tracks=>{const clean=Array.isArray(tracks)?tracks.filter(Boolean):[];if(!clean.length)return;await sync();if(state.items.length&&!confirm(`Replace the current queue with ${clean.length} search result${clean.length===1?"":"s"}?`))return;await replace(clean,0,"search");showNowPlaying(state.items[0]);};
  window.__dakshQueuePlay=showNowPlaying;
  document.getElementById("audio")?.addEventListener("ended",()=>next());
  window.addEventListener("keydown",e=>{if(e.key==="ArrowRight"&&document.activeElement?.tagName!=="INPUT")next();if(e.key==="ArrowLeft"&&document.activeElement?.tagName!=="INPUT")previous();});
  const style=document.createElement("style");style.textContent=`#dakshQueueOverlay{position:absolute;inset:22px 0 0;background:linear-gradient(180deg,var(--screen-top),var(--screen-bg));z-index:30;color:var(--screen-ink);display:flex;flex-direction:column}.dq-head{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border-bottom:1px solid rgba(0,0,0,.12);font-size:11px}.dq-head button,.dq-foot button{border:0;background:transparent;color:var(--screen-sub);font-size:9px;font-weight:700}.dq-body{overflow:auto}.dq-row{display:flex;flex-direction:column;padding:6px 9px;border-bottom:1px solid rgba(0,0,0,.06);font-size:10px;cursor:pointer}.dq-row small{font-size:8.5px;color:var(--screen-sub)}.dq-row.cur{background:linear-gradient(180deg,var(--sel-a),var(--sel-b));color:#fff}.dq-row.cur small{color:#dbe6f5}.dq-empty{padding:30px;text-align:center;font-size:10px;color:var(--screen-sub)}.dq-foot{margin-top:auto;padding:5px 9px;border-top:1px solid rgba(0,0,0,.08);text-align:right}`;document.head.appendChild(style);
  sync();
})();