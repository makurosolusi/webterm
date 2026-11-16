// Client side of /api/workspace-create (server: src/server/workspaceCreate/workspaceCreate.route.ts).
import type { CloneProgress } from '../../server/workspaceCreate/cloneUrl'
import type { Preflight } from '../../server/workspaceCreate/preflight'

export type { Preflight }
const PREFIX = '/api/workspace-create'
/** Remembers the last clone parent directory. */
export const PARENT_KEY = 'webterm.cloneParent'
/** Last parent used by New project, kept apart from the clone one. */
export const PROJECT_PARENT_KEY = 'webterm.projectParent'

const url = (p: string, extra: Record<string, string> = {}): string => {
  const q = new URLSearchParams(extra).toString()
  return `${PREFIX}${p}${q ? `?${q}` : ''}`
}

/** Error carrying the server's code; `aborted` means the user cancelled and is shown as nothing. */
export class CreateRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

async function failure(res: Response): Promise<CreateRequestError> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
  return new CreateRequestError(body?.error ?? `http_${res.status}`, body?.message ?? `Request failed (${res.status}).`)
}

const post = (p: string, body: unknown): Promise<Response> =>
  fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function postJson<T>(p: string, body: unknown): Promise<T> {
  const res = await post(p, body)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as T
}

export interface Defaults { parent: string; projectsFolder: string; builtin: string }

/** Server defaults; `remembered` comes back as `parent` only while it is still a folder. */
export async function fetchDefaults(remembered = ''): Promise<Defaults> {
  const res = await fetch(url('/defaults', remembered ? { remembered } : {}))
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Defaults
}

function recall(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' /* storage blocked: no suggestion */ }
}

/** Last parent used (a suggestion the server checks still exists), else the default projects folder. */
export async function initialParent(key: string = PARENT_KEY): Promise<string> {
  return (await fetchDefaults(recall(key))).parent
}

export function rememberParent(parent: string, key: string = PARENT_KEY): void {
  try { localStorage.setItem(key, parent) } catch { /* not remembered: next open uses the default */ }
}

/** Target, name taken (+ next free), wrong-place warnings and, with `url`, an existing clone. */
export function preflight(body: { parent: string; name: string; url?: string }): Promise<Preflight> {
  return postJson('/check', body)
}

/** Resolves when `path` may be the default projects folder; rejects with the reason otherwise. */
export async function checkProjectsFolder(path: string): Promise<void> {
  await postJson('/projects-folder/check', { path })
}

export async function revealPath(path: string): Promise<void> {
  await postJson('/reveal', { path })
}

/** Runs the clone, feeding NDJSON progress lines to `onProgress`; resolves the cloned path. */
export async function cloneRepo(body: { url: string; parent: string; name?: string }, onProgress: (p: CloneProgress) => void): Promise<string> {
  const res = await post('/clone', body)
  if (!res.ok || !res.body) throw await failure(res)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i)) as { type: string; path?: string; error?: string; message?: string; phase?: string; percent?: number }
      buf = buf.slice(i + 1)
      if (msg.type === 'progress') onProgress({ phase: msg.phase ?? '', percent: msg.percent ?? 0 })
      else if (msg.type === 'done' && msg.path) return msg.path
      else if (msg.type === 'error') throw new CreateRequestError(msg.error ?? 'git_failed', msg.message ?? 'Clone failed.')
    }
    if (done) throw new CreateRequestError('git_failed', 'The clone ended without a result.')
  }
}

export async function cancelClone(): Promise<void> {
  await post('/clone/cancel', {})
}

export async function createProject(body: { parent: string; name: string; gitInit: boolean }): Promise<string> {
  return (await postJson<{ path: string }>('/project', body)).path
}
