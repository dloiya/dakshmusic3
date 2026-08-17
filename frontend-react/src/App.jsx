import { useEffect, useState } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1'

async function getStatus() {
  const response = await fetch(`${API}/status`, { credentials: 'include' })
  if (!response.ok) throw new Error(`Status API ${response.status}`)
  return response.json()
}

export default function App() {
  const [status, setStatus] = useState({ active: 0, jobs: [] })
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const data = await getStatus()
        if (mounted) { setStatus(data); setError('') }
      } catch (err) {
        if (mounted) setError(err.message)
      }
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => { mounted = false; clearInterval(timer) }
  }, [])

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">dakshmusic3</p>
          <h1>Music Server</h1>
        </div>
        <div className="status-pill">{status.active || 0} active</div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Acquisition Status</h2>
          <span>{status.running || 0} running · {status.dispatched || 0} dispatched · {status.queued || 0} queued</span>
        </div>
        {error && <div className="error">{error}</div>}
        {status.jobs?.length ? (
          <div className="jobs">
            {status.jobs.map(job => (
              <article className="job" key={job.job_id}>
                <div>
                  <strong>{job.title}</strong>
                  <small>{job.artist}{job.album_name ? ` · ${job.album_name}` : ''}</small>
                </div>
                <div className={`state ${job.status}`}>{job.status}</div>
              </article>
            ))}
          </div>
        ) : <div className="empty">No acquisition workers are active.</div>}
      </section>
    </main>
  )
}
