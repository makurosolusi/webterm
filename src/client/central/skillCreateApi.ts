// Skill draft writes (`POST .../skills`, `.../versions`, `.../fork`): keeps the server's lint issue codes, which the shared `request` helper drops.
import { InboxApiError } from '../inboxTypes'
import type { SkillDraftInput } from './centralControlTypes'

/** A refused write: `code` is the server error code (`http_<status>` when the body is not JSON), `issues` the lint issue codes (never content). */
export class SkillCreateError extends InboxApiError {
  readonly issues: readonly string[]
  constructor(status: number, code: string, issues: readonly string[]) {
    super(`skill request failed (${status} ${code})`, status, code)
    this.name = 'SkillCreateError'
    this.issues = issues
  }
}

/** Typed error of a non-OK response; a body that is not JSON becomes the `http_<status>` code instead of being dropped. */
async function failureOf(res: Response): Promise<SkillCreateError> {
  const parsed: unknown = await res.json().catch(() => null)
  const body = parsed !== null && typeof parsed === 'object' ? (parsed as { error?: unknown; issues?: unknown }) : {}
  const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
  const issues = Array.isArray(body.issues) ? body.issues.filter((i): i is string => typeof i === 'string') : []
  return new SkillCreateError(res.status, code, issues)
}

/** POSTs JSON and returns the parsed OK body; throws `SkillCreateError` otherwise. */
export async function skillPost(path: string, input: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (!res.ok) throw await failureOf(res)
  return (await res.json()) as Record<string, unknown>
}

export async function createSkillRequest(path: string, input: SkillDraftInput): Promise<void> {
  await skillPost(path, input)
}
