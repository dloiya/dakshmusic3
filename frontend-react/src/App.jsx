import { useEffect, useState } from 'react'
import { api, auth } from './api'

const tabs = ['Library', 'Search', 'Queue', 'Acquisition', 'Settings']

export default function App() {
  const [authenticated, setAuthenticated] = useState(false)
  const [password, setPassword] = useState('')
  const [tab, setTab] = useState('Library')
  const [tracks, setTracks] = useState([])
  const [jobs, setJobs] = useState({ active: 0, jobs: [] })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const [session, library, status] = await Promise.all([auth.session(), api('/library/tracks?limit=100'), api('/status')])
      setAuthenticated(session.authenticated)
      setTracks(library.items || [])
      setJobs(status)
      setError('')
    } catch (e) { setError(e.message) }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const timer = setInterval(async () => {
      try { setJobs(await api('/status')) } catch { /* status is best effort */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  const login = async e => {
    e.preventDefault()
    try { await auth.login(password); setPassword(''); setAuthenticated(true); await load() } catch (e) { setError(e.message) }
  }

  if (!authenticated) return <main className="auth"><form onSubmit={login}><div className="logo">daksh music</div><h1>Music Server</h1><input autoFocus type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"/><button>Login</button>{error && <p className="error">{error}</p>}</form></main>

  const visible = query ? tracks.filter(t => `${t.title} ${t.artist} ${t.album_name || ''}`.toLowerCase().includes(query.toLowerCase())) : tracks

  return <main className="app">
    <header><div><div className="logo">daksh music</div><h1>{tab}</h1></div><div className="live">{jobs.active || 0} active</div></header>
    <nav>{tabs.map(t => <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>{t}</button>)}</nav>
    {error && <div className="error banner">{error}</div>}
    {tab === 'Library' && <section className="panel"><div className="toolbar"><strong>{tracks.length} tracks</strong><button onClick={load}>Refresh</button></div>{visible.map(t => <article className="track" key={t.id}><div><strong>{t.title}</strong><small>{t.artist}{t.album_name ? ` · ${t.album_name}` : ''}</small></div><span>{t.storage_status}</span></article>)}</section>}
    {tab === 'Search' && <section className="panel"><input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Song, artist, album"/>{visible.map(t => <article className="track" key={t.id}><div><strong>{t.title}</strong><small>{t.artist}</small></div><button onClick={() => api('/queue/' + t.id).catch(e => setError(e.message))}>Queue</button></article>)}</section>}
    {tab === 'Queue' && <section className="panel"><QueueView/></section>}
    {tab === 'Acquisition' && <section className="panel"><div className="toolbar"><strong>Active workers</strong><span>{jobs.active}</span></div>{jobs.jobs?.map(j => <article className="track" key={j.job_id}><div><strong>{j.title}</strong><small>{j.artist}{j.album_name ? ` · ${j.album_name}` : ''}</small></div><span className={`state ${j.status}`}>{j.status}</span></article>)}</section>}
    {tab === 'Settings' && <SettingsView onLogout={async () => { await auth.logout(); setAuthenticated(false) }} onImport={load}/>} 
  </main>
}

function QueueView() {
  const [data, setData] = useState({ entries: [] })
  useEffect(() => { api('/queue').then(setData).catch(() => {}) }, [])
  return data.entries?.length ? data.entries.map(e => <article className="track" key={e.id}><div><strong>{e.title}</strong><small>{e.artist}</small></div><span>#{e.position + 1}</span></article>) : <div className="empty">Queue is empty.</div>
}

function SettingsView({ onLogout, onImport }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const importCsv = async e => { const file = e.target.files?.[0]; if (!file) return; setBusy(true); try { const body = new FormData(); body.append('file', file); const r = await api('/seed', { method: 'POST', body }); setMessage(`Imported ${r.imported} rows; ${r.top_cache_candidates} Top Cache candidates.`); onImport() } catch (x) { setMessage(x.message) } finally { setBusy(false); e.target.value = '' } }
  const populate = async () => { setBusy(true); try { const r = await api('/cache/populate', { method: 'POST' }); setMessage(`${r.count} Top Cache candidates ready.`) } catch (e) { setMessage(e.message) } finally { setBusy(false) } }
  return <section className="panel settings"><label className="action">Import Library CSV<input type="file" accept=".csv,text/csv" onChange={importCsv} hidden/></label><button onClick={populate} disabled={busy}>Populate Top Cache</button><button className="danger" onClick={onLogout}>Logout</button>{message && <p>{message}</p>}</section>
}
