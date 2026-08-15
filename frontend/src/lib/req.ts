import { api } from './api'

const TOKEN_KEY = 'gridConsoleToken'

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
export function setToken(t: string) {
  try { localStorage.setItem(TOKEN_KEY, t) } catch { /* ignore */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
}

function authHeaders(base?: Record<string, string>): Record<string, string> {
  const t = getToken()
  const h: Record<string, string> = { ...(base || {}) }
  if (t) h['Authorization'] = `Bearer ${t}`
  return h
}

// When the backend rejects our token, drop it and let the app show the gate.
function handleUnauthorized() {
  clearToken()
  try { window.dispatchEvent(new CustomEvent('auth-required')) } catch { /* ignore */ }
}

export async function getJSON<T = any>(path: string): Promise<T> {
  const r = await fetch(api(path), { headers: authHeaders() })
  if (r.status === 401) { handleUnauthorized(); throw new Error('未授权') }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.error || `请求失败 (${r.status})`)
  }
  return r.json()
}

export async function postJSON<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401) { handleUnauthorized(); throw new Error('未授权') }
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`)
  return json
}

export async function putJSON<T = any>(path: string, body?: any): Promise<T> {
  const r = await fetch(api(path), {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401) { handleUnauthorized(); throw new Error('未授权') }
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`)
  return json
}

export function num(v: any, d = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export function fmt(v: any, digits = 2): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtSigned(v: any, digits = 2): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const s = fmt(Math.abs(n), digits)
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s
}

export function pnlColor(v: any): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return 'text-slate-300'
  return n > 0 ? 'text-emerald-400' : 'text-rose-400'
}
