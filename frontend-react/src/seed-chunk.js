const SEED_CHUNK_SIZE = 10
const METADATA_CHUNK_SIZE = 1

function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; continue }
      if (c === '"') { quoted = false; continue }
      field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(v => v !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row) }
  if (!rows.length) return []
  const headers = rows.shift().map(h => h.trim().replace(/^\uFEFF/, ''))
  return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])))
}

function progressBox() {
  let el = document.getElementById('seed-progress')
  if (el) return el
  el = document.createElement('div')
  el.id = 'seed-progress'
  el.style.cssText = 'position:fixed;inset:0;background:#0009;z-index:99999;display:grid;place-items:center;font-family:Arial,sans-serif'
  el.innerHTML = '<div style="width:min(380px,90vw);background:linear-gradient(#f5f5f5,#c9c9c9);border:4px solid #222;border-radius:15px;padding:16px;box-shadow:0 25px 80px #000"><b style="font-size:16px">Import Library</b><div id="seed-progress-text" style="margin:12px 0 8px;font-size:12px">Preparing…</div><div style="height:10px;background:#999;border-radius:6px;overflow:hidden"><div id="seed-progress-bar" style="height:100%;width:0;background:#222"></div></div></div>'
  document.body.appendChild(el)
  return el
}

function updateProgress(done, total, text) {
  progressBox()
  const pct = total ? Math.round(done / total * 100) : 0
  document.getElementById('seed-progress-text').textContent = text || `${done.toLocaleString()} / ${total.toLocaleString()} rows (${pct}%)`
  document.getElementById('seed-progress-bar').style.width = `${pct}%`
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.detail || payload.error || `${url} failed (${response.status})`)
  return payload
}

async function importInChunks(file) {
  const text = await file.text()
  const rows = parseCsv(text)
  if (!rows.length) throw new Error('CSV contains no data rows')

  // Phase 1: finish the entire seed before any metadata work starts.
  let jobId = null
  let processed = 0
  for (let i = 0; i < rows.length; i += SEED_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + SEED_CHUNK_SIZE)
    updateProgress(processed, rows.length, `Seeding ${processed.toLocaleString()} / ${rows.length.toLocaleString()}…`)
    const payload = await postJson('/api/v1/seed/chunk', {
      filename: file.name, job_id: jobId, rows: chunk, total: rows.length, done: i + chunk.length >= rows.length
    })
    jobId = payload.job_id
    processed += chunk.length
    updateProgress(processed, rows.length, `Seeding ${processed.toLocaleString()} / ${rows.length.toLocaleString()}…`)
  }

  // Phase 2: metadata starts only after the final seed request succeeds.
  let metadataDone = 0
  let metadataFilled = 0
  for (let i = 0; i < rows.length; i += METADATA_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + METADATA_CHUNK_SIZE)
    const payload = await postJson('/api/v1/metadata/chunk', { rows: chunk })
    metadataDone += chunk.length
    metadataFilled += payload.enriched || 0
    updateProgress(metadataDone, rows.length, `Metadata ${metadataDone.toLocaleString()} / ${rows.length.toLocaleString()} · filled ${metadataFilled.toLocaleString()}`)
  }

  updateProgress(rows.length, rows.length, `Import complete · ${rows.length.toLocaleString()} tracks · metadata filled ${metadataFilled.toLocaleString()}`)
  setTimeout(() => document.getElementById('seed-progress')?.remove(), 1200)
}

document.addEventListener('change', event => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.accept.includes('csv')) return
  const file = input.files?.[0]
  if (!file) return
  event.stopPropagation()
  event.preventDefault()
  progressBox()
  importInChunks(file).catch(error => {
    updateProgress(0, 1, `Import failed: ${error.message}`)
    setTimeout(() => document.getElementById('seed-progress')?.remove(), 2500)
  }).finally(() => { input.value = '' })
}, true)
