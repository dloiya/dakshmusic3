import { useEffect, useMemo, useState } from 'react'
import { api, auth } from './api'

const tabs=['Library','Search','Queue','Acquisition','Settings']

export default function App(){
  const [authenticated,setAuthenticated]=useState(false),[password,setPassword]=useState(''),[tab,setTab]=useState('Library')
  const [tracks,setTracks]=useState([]),[searchResults,setSearchResults]=useState([]),[jobs,setJobs]=useState({active:0,jobs:[],counts:{}})
  const [query,setQuery]=useState(''),[error,setError]=useState(''),[modal,setModal]=useState(null)

  const load=async()=>{try{const session=await auth.session();setAuthenticated(session.authenticated);if(!session.authenticated)return;const [library,status]=await Promise.all([api('/library/tracks?limit=200'),api('/status')]);setTracks(library.items||[]);setJobs(status);setError('')}catch(e){setError(e.message)}}
  useEffect(()=>{load()},[])
  useEffect(()=>{if(!authenticated)return;const timer=setInterval(()=>api('/status').then(setJobs).catch(()=>{}),2000);return()=>clearInterval(timer)},[authenticated])

  const login=async e=>{e.preventDefault();try{await auth.login(password);setPassword('');setAuthenticated(true);await load()}catch(e){setError(e.message)}}
  const doSearch=async()=>{if(!query.trim()){setSearchResults([]);return}try{setSearchResults((await api(`/search?q=${encodeURIComponent(query)}&limit=30`)).items||[]);setError('')}catch(e){setError(e.message)}}
  const queue=async id=>{try{await api(`/queue/${id}`,{method:'POST'});setTab('Queue')}catch(e){setError(e.message)}}

  if(!authenticated)return <main className="auth"><form onSubmit={login}><div className="logo">daksh music</div><h1>Music Server</h1><input autoFocus type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password"/><button>Login</button>{error&&<p className="error">{error}</p>}</form></main>

  return <main className="app">
    <header><div><div className="logo">daksh music</div><h1>{tab}</h1></div><button className="live" onClick={()=>setModal('status')}>{jobs.active||0} active workers</button></header>
    <nav>{tabs.map(t=><button className={tab===t?'active':''} onClick={()=>setTab(t)} key={t}>{t}</button>)}</nav>
    {error&&<div className="error banner">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
    {tab==='Library'&&<Library tracks={tracks} refresh={load} onQueue={queue}/>} 
    {tab==='Search'&&<Search query={query} setQuery={setQuery} results={searchResults} search={doSearch} onQueue={queue}/>} 
    {tab==='Queue'&&<QueueView onError={setError}/>} 
    {tab==='Acquisition'&&<Acquisition jobs={jobs} refresh={()=>api('/status').then(setJobs)}/>} 
    {tab==='Settings'&&<Settings onLogout={async()=>{await auth.logout();setAuthenticated(false)}} onImport={load} onClear={()=>setModal('clear')}/>} 
    {modal==='status'&&<StatusModal jobs={jobs} close={()=>setModal(null)}/>} 
    {modal==='clear'&&<ClearModal close={()=>setModal(null)} done={load}/>} 
  </main>
}

function Library({tracks,refresh,onQueue}){return <section className="panel"><div className="toolbar"><strong>{tracks.length} tracks</strong><button onClick={refresh}>Refresh</button></div>{tracks.map(t=><article className="track" key={t.id}><div><strong>{t.title}</strong><small>{t.artist}{t.album_name?` · ${t.album_name}`:''}</small></div><div className="row-actions"><span className={`state ${t.storage_status}`}>{t.storage_status}</span><button onClick={()=>onQueue(t.id)}>Queue</button></div></article>)}{!tracks.length&&<div className="empty">Library is empty. Import a CSV from Settings.</div>}</section>}

function Search({query,setQuery,results,search,onQueue}){return <section className="panel"><div className="searchbar"><input className="search" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder="Song, artist, album"/><button onClick={search}>Search</button></div>{results.map(t=><article className="track" key={`${t.source}-${t.source_id}`}><div><strong>{t.title}</strong><small>{t.artist}{t.album_name?` · ${t.album_name}`:''}</small></div><button onClick={async()=>{try{const r=await api('/library/tracks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(t)});onQueue(r.id)}catch(e){/* queue only after imported track */}}}>Add & Queue</button></article>)}{query&&!results.length&&<div className="empty">No search results.</div>}</section>}

function QueueView({onError}){const [data,setData]=useState({entries:[]});const load=()=>api('/queue').then(setData).catch(e=>onError(e.message));useEffect(load,[]);const shuffle=()=>api('/queue/shuffle',{method:'POST'}).then(setData).catch(e=>onError(e.message));const clear=()=>api('/queue',{method:'DELETE'}).then(load).catch(e=>onError(e.message));return <section className="panel"><div className="toolbar"><strong>{data.entries?.length||0} queued</strong><div><button onClick={shuffle}>Shuffle</button><button onClick={clear}>Clear</button></div></div>{data.entries?.map(e=><article className="track" key={e.id}><div><strong>{e.title}</strong><small>{e.artist}{e.album_name?` · ${e.album_name}`:''}</small></div><span>#{e.position+1}</span></article>)}{!data.entries?.length&&<div className="empty">Queue is empty.</div>}</section>}

function Acquisition({jobs,refresh}){return <section className="panel"><div className="toolbar"><strong>Acquisition workers</strong><span className="status-pill">{jobs.active||0} active</span></div>{jobs.jobs?.map(j=><article className="track" key={j.job_id}><div><strong>{j.title}</strong><small>{j.artist}{j.album_name?` · ${j.album_name}`:''}</small></div><span className={`state ${j.status}`}>{j.status}</span></article>)}{!jobs.jobs?.length&&<div className="empty">No acquisition jobs.</div>}<div className="toolbar"><button onClick={refresh}>Refresh status</button></div></section>}

function Settings({onLogout,onImport,onClear}){const [busy,setBusy]=useState(false),[message,setMessage]=useState('');const importCsv=async e=>{const file=e.target.files?.[0];if(!file)return;setBusy(true);setMessage('');try{const body=new FormData();body.append('file',file);const r=await api('/seed',{method:'POST',body});setMessage(`Import complete: ${r.imported} imported, ${r.failed} failed.`);onImport()}catch(x){setMessage(x.message)}finally{setBusy(false);e.target.value=''}};const populate=async()=>{setBusy(true);try{const r=await api('/cache/populate',{method:'POST'});setMessage(`Top Cache: ${r.requested} songs queued.`)}catch(e){setMessage(e.message)}finally{setBusy(false)}};return <section className="panel settings"><label className="action">{busy?'Importing…':'Import Library CSV'}<input type="file" accept=".csv,text/csv" onChange={importCsv} hidden disabled={busy}/></label><button onClick={populate} disabled={busy}>Populate Top Cache</button><button className="danger" onClick={onClear} disabled={busy}>Clear All Data</button><button onClick={onLogout}>Logout</button>{message&&<p>{message}</p>}</section>}

function StatusModal({jobs,close}){return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h2>Running processes</h2><button onClick={close}>Close</button></div><p className="muted">Live acquisition worker state. This view updates automatically.</p>{jobs.jobs?.filter(j=>['queued','dispatched','running'].includes(j.status)).map(j=><div className="process" key={j.job_id}><div><strong>{j.title}</strong><small>{j.artist}</small></div><span className={`state ${j.status}`}>{j.status}</span></div>)}{!(jobs.jobs||[]).some(j=>['queued','dispatched','running'].includes(j.status))&&<div className="empty">No active acquisition processes.</div>}</div></div>}

function ClearModal({close,done}){const [busy,setBusy]=useState(false),[error,setError]=useState('');const clear=async()=>{setBusy(true);setError('');try{await api('/crud/clear-all',{method:'POST'});close();await done()}catch(e){setError(e.message)}finally{setBusy(false)}};return <div className="modal-backdrop"><div className="modal"><div className="modal-head"><h2>Clear all data?</h2><button onClick={close}>Cancel</button></div><p>This removes the library, playlist, queue, acquisition history, cache records, sessions, imports, and R2 audio objects.</p>{error&&<p className="error">{error}</p>}<button className="danger full" onClick={clear} disabled={busy}>{busy?'Clearing…':'Yes, clear everything'}</button></div></div>}
