const API = import.meta.env.VITE_API_URL || '/api/v1'

export async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`)
  return data
}
