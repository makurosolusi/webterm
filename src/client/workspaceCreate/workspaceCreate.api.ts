// Client side of /api/workspace-create (server: src/server/workspaceCreate/workspaceCreate.route.ts).
import { tokenQuery } from '../api'
import type { CloneProgress } from '../../server/workspaceCreate/cloneUrl'

const PREFIX = '/api/workspace-create'
/** nodeterm remembers the last clone parent under `nodeterm.cloneParent`; both dialogs share ours. */
export const PARENT_KEY = 'webterm.cloneParent'

const url = (p: string): string => {
  const q = tokenQuery()
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

/** Last parent used, else the server's default (~/projects or home, as nodeterm). */
export async function initialParent(): Promise<string> {
  try {
    const remembered = localStorage.getItem(PARENT_KEY)
    if (remembered) return remembered
  } catch { /* storage blocked: fall through to the server default */ }
  const res = await fetch(url('/defaults'))
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { parent: string }).parent
}

export function rememberParent(parent: string): void {
  try { localStorage.setItem(PARENT_KEY, parent) } catch { /* not remembered: next open uses the default */ }
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
  const res = await post('/project', body)
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { path: string }).path
}
