const API = import.meta.env.VITE_API_URL || '/api/v1'

export async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { credentials: 'include', ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

export const auth = {
  session: () => api('/auth/session'),
  login: password => api('/auth/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ password }) }),
  logout: () => api('/auth/logout', { method: 'POST' }),
}
