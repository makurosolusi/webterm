// Pure helpers of the Skills library: search, limits, name handling and error text. No React.
import { InboxApiError } from '../inboxTypes'
import { CL } from './centralLabels'
import type { SkillReviewRow } from './centralControlTypes'
import { SkillCreateError } from './skillCreateApi'

// Mirror of the server limits (server/central/skills/skillLint.ts); the server stays the authority.
export const MAX_WHEN = 300
export const MAX_INSTRUCTIONS = 4000
export const NAME_PREFIX = CL.skillNamePrefix
const NAME_TAIL = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_TAIL = 64 - NAME_PREFIX.length

/** Tool verbs a human may attach to a draft (the ones the shipped skills use); a preset, so no free typing. */
export const CAP_PRESETS: readonly string[] = ['portfolio.read', 'skill.list', 'skill.load', 'approval.request']

/** What the user typed after the fixed prefix; a pasted `webterm-` prefix is not doubled. */
export const tailOf = (typed: string): string => typed.trim().toLowerCase().replace(/^webterm-/, '')
export const fullName = (typed: string): string => `${NAME_PREFIX}${tailOf(typed)}`
export const nameValid = (typed: string): boolean => NAME_TAIL.test(tailOf(typed)) && tailOf(typed).length <= MAX_TAIL

/** The form can be sent: every field is within the same limits the server enforces. */
export function draftValid(f: { name: string; when: string; body: string }): boolean {
  return nameValid(f.name) && f.when.trim() !== '' && f.when.length <= MAX_WHEN && !/[\r\n]/.test(f.when) && f.body.trim() !== '' && f.body.length <= MAX_INSTRUCTIONS
}

/** Case-insensitive match on name, description, origin and status; an empty query keeps everything. */
export function searchRows(rows: readonly SkillReviewRow[], query: string): SkillReviewRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter(({ record: r, description }) => [r.name, description, r.origin, r.status].some((v) => v.toLowerCase().includes(q)))
}

/** Rows that need a human decision or can be rolled back; the rest is browse-only. */
export const needsReview = (r: SkillReviewRow): boolean => r.record.status !== 'active' || r.canRollback

/** Human lines for a failed create: lint issue codes first, else the server error code, never a raw JSON or status line. */
export function createErrorLines(err: unknown): string[] {
  if (err instanceof SkillCreateError) {
    const codes = err.issues.length > 0 ? err.issues : [err.code]
    return codes.map((c) => CL.skillErrors[c] ?? CL.skillCreateFailed)
  }
  if (err instanceof InboxApiError && CL.skillErrors[err.code]) return [CL.skillErrors[err.code]]
  return [CL.skillCreateFailed]
}
