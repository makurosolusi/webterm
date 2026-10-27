// Thin same-origin REST wrappers for the workspace API. JSON in/out; throw on non-2xx.
import type { Workspace } from '../shared/workspace'

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`)
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

export function saveWorkspace(ws: Workspace): Promise<Workspace> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ws),
  })
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
