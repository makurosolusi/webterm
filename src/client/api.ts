// Thin same-origin REST wrappers for the workspace API. JSON in/out; throw on non-2xx.
import type { Workspace } from '../shared/workspace'
// No credential is attached here: every same-origin request carries the HttpOnly `wt_ui` session
// cookie (fetch defaults to `credentials: 'same-origin'`). See transportToken.ts for sign-in.

/** Thrown on non-2xx. `body` is the parsed JSON error body when there is one (a stale save's 409
 *  carries the `current` board); `serverMessage` is its human-readable `error`/`message`. */
export type HttpError = Error & { status: number; body?: unknown; serverMessage?: string }

/** The server's own explanation in an error body (`{ error }` or `{ message }`), if any. */
function serverMessageOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const { error, message } = body as { error?: unknown; message?: unknown }
  const text = typeof message === 'string' ? message : typeof error === 'string' ? error : undefined
  return text?.trim() || undefined
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    // A non-JSON error body leaves `body` unset; the status still says what went wrong.
    const body: unknown = await Promise.resolve().then(() => res.json()).catch(() => undefined)
    const serverMessage = serverMessageOf(body)
    const e = new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}${serverMessage ? `: ${serverMessage}` : ''}`) as HttpError
    e.status = res.status
    e.body = body
    e.serverMessage = serverMessage
    throw e
  }
  return res.json() as Promise<T>
}

/** Bytes a request body may have and still use `keepalive`. The browser caps the SUM of all
 *  in-flight keepalive bodies at 64 KiB; a board takes at most this share so a settings flush
 *  (`SETTINGS_KEEPALIVE_MAX_BYTES`) fits beside it. Above it the save is an ordinary fetch. */
export const BOARD_KEEPALIVE_MAX_BYTES = 48 * 1024
export const SETTINGS_KEEPALIVE_MAX_BYTES = 16 * 1024

/** Whether `body` is small enough for a `keepalive` request: one that the browser still delivers
 *  after the page unloads (a plain fetch is cancelled with the document). */
export function fitsKeepalive(body: string, maxBytes: number): boolean {
  return new TextEncoder().encode(body).length <= maxBytes
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

/** `signal` lets a superseded navigation (a later workspace click) cancel this read. */
export function getWorkspace(id: string, signal?: AbortSignal): Promise<Workspace> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, signal ? { signal } : undefined)
}

/** PUT a board. `ws.updatedAt` must be the version the caller last got from the server: a newer
 *  stored board answers 409 (`body.current`), a deleted one 404. Sent `keepalive` when it fits, so
 *  a save flushed on page hide still lands after the tab is gone. */
export function saveWorkspace(ws: Workspace): Promise<Workspace> {
  const body = JSON.stringify(ws)
  return jsonFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: fitsKeepalive(body, BOARD_KEEPALIVE_MAX_BYTES),
  })
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error(`PUT /api/active -> ${res.status}`)
}

export function listDir(path?: string): Promise<{ path: string; parent: string | null; dirs: string[] }> {
  return jsonFetch('/api/fs' + (path ? `?path=${encodeURIComponent(path)}` : ''))
}

export function generateName(nodeId: string): Promise<{ ok: boolean; message: string }> {
  return jsonFetch('/api/generate-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node: nodeId }),
  })
}
