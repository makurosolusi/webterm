// Client side of /api/bakeoff (src/server/bakeoff/bakeoff.api.ts): request helper, product text and
// the small formatters the comparison cards use.
import { TOKEN_HEADER } from '../api'
import { peekToken } from '../transportToken'
import type { BakeoffView, CandidateView } from '../../server/bakeoff/bakeoff.store'

export type { BakeoffView, CandidateView }
export const BAKEOFF_API = '/api/bakeoff'
export const BAKEOFF_POLL_MS = 3000

export const BAKEOFF_TEXT = {
  command: 'Bake-off: Compare Agents on One Prompt…',
  title: 'Bake-off',
  intro: 'Run one prompt on several Claude Code agents, each in its own git worktree, then compare the results and pick a winner. Nothing is merged or deleted until you say so.',
  prompt: 'Prompt', count: 'Agents', start: 'Start bake-off', starting: 'Starting…',
  noRepo: 'Open a workspace with a git folder first.',
  recent: 'Recent bake-offs', none: 'No bake-offs yet.',
  pick: 'Pick as winner', winner: 'Winner',
  merge: (branch: string) => `Merge winner into ${branch}`,
  cleanup: 'Clean up worktrees…',
  confirmCleanup: (n: number) => `Remove ${n} worktree${n === 1 ? '' : 's'} and their branches. Uncommitted work in them is lost.`,
  confirm: 'Remove', cancel: 'Cancel',
  verified: 'Verified', unverified: 'Not verified', running: 'Running…', noVerdict: 'No verdict',
  status: { running: 'Running', ready: 'Pick a winner', picked: 'Winner picked', merged: 'Merged', cleaned: 'Done' },
} as const

/** JSON request; a non-2xx answer throws with the server's message, except `allow` statuses which return the body. */
export async function bakeoffRequest(method: 'GET' | 'POST', path = BAKEOFF_API, body?: unknown, allow: number[] = []): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok && !allow.includes(res.status)) {
    const e = (out ?? {}) as { message?: string; error?: string }
    throw new Error(e.message ?? e.error ?? `${method} ${path} failed (${res.status})`)
  }
  return out
}

export const formatCost = (micros: number | null): string => (micros === null ? 'cost unknown' : `$${(micros / 1e6).toFixed(2)}`)
export const formatDuration = (ms: number | null): string => {
  if (ms === null) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
/** "3 files · tests 12/12 · typecheck ok" from the verifier verdict. */
export function verdictLine(c: CandidateView): string {
  const v = c.verdict
  if (!v) return c.status === 'running' ? BAKEOFF_TEXT.running : BAKEOFF_TEXT.noVerdict
  const parts = [`${v.filesChanged} file${v.filesChanged === 1 ? '' : 's'}`]
  if (v.tests) parts.push(`tests ${v.tests.passed}/${v.tests.passed + v.tests.failed}`)
  if (v.typecheck !== null) parts.push(`typecheck ${v.typecheck ? 'ok' : 'failed'}`)
  return parts.join(' · ')
}
