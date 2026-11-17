// Pure helpers of the Skills library: search, display title and review filter. No React.
import type { SkillReviewRow } from './centralControlTypes'

/** What a row is called in the UI: its title, or the name for a skill approved before titles existed. */
export const titleOf = (r: SkillReviewRow): string => r.record.title?.trim() || r.record.name

/** Case-insensitive match on title, name, description, origin and status; an empty query keeps everything. */
export function searchRows(rows: readonly SkillReviewRow[], query: string): SkillReviewRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => [titleOf(r), r.record.name, r.description, r.record.origin, r.record.status].some((v) => v.toLowerCase().includes(q)))
}

/** Rows that need a human decision or can be rolled back; the rest is browse-only. */
export const needsReview = (r: SkillReviewRow): boolean => r.record.status !== 'active' || r.canRollback

export type SkillFilter = 'all' | 'active' | 'disabled' | 'review'
export const SKILL_FILTERS: readonly SkillFilter[] = ['all', 'active', 'disabled', 'review']

/** Switched off by the human (the `enabled` flag) or by status. */
export const isOff = (r: SkillReviewRow): boolean => r.record.status === 'disabled' || r.record.enabled === false

/** Whether a row belongs under a status filter; "active" means approved and switched on. */
export function matchesFilter(r: SkillReviewRow, f: SkillFilter): boolean {
  if (f === 'active') return r.record.status === 'active' && !isOff(r)
  if (f === 'disabled') return isOff(r)
  if (f === 'review') return needsReview(r)
  return true
}

/** Row counts per filter, for the segmented control. */
export const countByFilter = (rows: readonly SkillReviewRow[]): Record<SkillFilter, number> =>
  Object.fromEntries(SKILL_FILTERS.map((f) => [f, rows.filter((r) => matchesFilter(r, f)).length])) as Record<SkillFilter, number>
