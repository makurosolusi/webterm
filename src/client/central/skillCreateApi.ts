// `POST /api/central/skills`: keeps the server's lint issue codes, which the shared `request` helper drops.
import { InboxApiError } from '../inboxTypes'
import type { SkillDraftInput } from './centralControlTypes'

/** A rejected draft: `code` is the server error code, `issues` the lint issue codes (never content). */
export class SkillCreateError extends InboxApiError {
  readonly issues: readonly string[]
  constructor(status: number, code: string, issues: readonly string[]) {
    super(`create skill failed (${status} ${code})`, status, code)
    this.name = 'SkillCreateError'
    this.issues = issues
  }
}

export async function createSkillRequest(path: string, input: SkillDraftInput): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (res.ok) return
  let body: { error?: unknown; issues?: unknown } = {}
  try { body = (await res.json()) as typeof body } catch { /* non-JSON error body: fall back to the status code */ }
  const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
  const issues = Array.isArray(body.issues) ? body.issues.filter((i): i is string => typeof i === 'string') : []
  throw new SkillCreateError(res.status, code, issues)
}
