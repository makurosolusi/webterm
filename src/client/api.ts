// Thin same-origin REST wrappers for the workspace API. JSON in/out; throw on non-2xx.
import type { Workspace } from '../shared/workspace'
import { TOKEN_KEY, TOKEN_PARAM } from './transportToken'

/** Must match TOKEN_HEADER / TOKEN_PARAM in src/server/auth.ts. */
export const TOKEN_HEADER = 'x-webterm-token'

/**
 * The transport token, when the server asked for one (non-loopback bind). It arrives once in
 * the page URL — `?token=…` — and is moved straight into sessionStorage so it does not sit in
 * the address bar to be screenshotted, bookmarked or pasted into a chat. sessionStorage, not
 * local: the token should not outlive the tab.
 *
 * Returns '' on the loopback default, where no token exists and nothing about the client's
 * behaviour changes.
 */
function sessionStore(): Storage | null {
  // Private mode and blocked site data make even *touching* sessionStorage throw; a token read
  // from the URL must still work there, it just will not survive a reload.
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function readToken(): string {
  if (typeof location === 'undefined' || typeof location.href !== 'string') return '' // non-browser
  const store = sessionStore()
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get(TOKEN_PARAM)
  if (fromUrl === null || fromUrl === '') return store?.getItem(TOKEN_KEY) ?? ''
  try {
    store?.setItem(TOKEN_KEY, fromUrl)
  } catch {
    // Safari private mode allows the read but throws on write (quota 0). The token still works
    // for this page load; only persistence across a reload is lost.
  }
  url.searchParams.delete(TOKEN_PARAM)
  if (typeof history !== 'undefined') history.replaceState(null, '', url.pathname + url.search + url.hash)
  return fromUrl
}

const token = readToken()

/** Whether this page load carries a token (URL or sessionStorage). */
export function hasToken(): boolean {
  return token !== ''
}

// `token` above is captured at import, so a freshly typed token only takes effect after a reload:
// the login flow stores it here, then App reloads the page and readToken() picks it up next load.
export function storeToken(t: string): void {
  try {
    sessionStore()?.setItem(TOKEN_KEY, t)
  } catch {}
}

export function clearToken(): void {
  try {
    sessionStore()?.removeItem(TOKEN_KEY)
  } catch {}
}

/** Probe /api/workspaces with a candidate token; true when the server accepts it. */
export async function validateToken(t: string): Promise<boolean> {
  const res = await fetch('/api/workspaces', { headers: { [TOKEN_HEADER]: t } })
  return res.ok
}

/** Query suffix carrying the token, or '' when there is none. For the WebSocket URL, which
 *  cannot carry headers. Caller supplies the leading separator. */
export function tokenQuery(): string {
  return token === '' ? '' : `${TOKEN_PARAM}=${encodeURIComponent(token)}`
}

/** Request headers plus the token header when there is one — absent entirely otherwise. */
function withToken(headers?: Record<string, string>): Record<string, string> | undefined {
  if (token === '') return headers
  return { ...headers, [TOKEN_HEADER]: token }
}

const HTTP_CONFLICT = 409

/** Thrown on non-2xx. `body` is set only for 409, whose body (e.g. a stale save's `current`
 *  board) is what the caller needs to recover. */
export type HttpError = Error & { status: number; body?: unknown }

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: withToken(init?.headers as Record<string, string>) })
  if (!res.ok) {
    const e = new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`) as HttpError
    e.status = res.status
    // A non-JSON 409 body leaves `body` unset; the status still reports the conflict.
    if (res.status === HTTP_CONFLICT) e.body = await res.json().catch(() => undefined)
    throw e
  }
  return res.json() as Promise<T>
}

export function fetchWorkspaces(): Promise<Workspace[]> {
  return jsonFetch('/api/workspaces')
}

export function createWorkspace(name: string, cwd?: string, color?: string): Promise<Workspace> {
  return jsonFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cwd, color }),
  })
}

export function getWorkspace(id: string): Promise<Workspace> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`)
}

/** PUT a board. `ws.updatedAt` must be the version the caller last got from the server: a newer
 *  stored board answers 409 (`body.current`), a deleted one 404. */
export function saveWorkspace(ws: Workspace): Promise<Workspace> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ws),
  })
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: withToken(),
  })
  if (!res.ok) throw new Error(`DELETE /api/workspaces/${id} -> ${res.status}`)
}

export async function getActive(): Promise<string | null> {
  const r = await jsonFetch<{ id: string | null }>('/api/active')
  return r.id
}

export async function setActive(id: string): Promise<void> {
  const res = await fetch('/api/active', {
    method: 'PUT',
    headers: withToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`PUT /api/active -> ${res.status}`)
}

export function listDir(path?: string): Promise<{ path: string; parent: string | null; dirs: string[] }> {
  return jsonFetch('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''))
}

export function generateName(nodeId: string): Promise<{ ok: boolean; message: string }> {
  return jsonFetch(`/api/generate-name?node=${encodeURIComponent(nodeId)}`)
}
