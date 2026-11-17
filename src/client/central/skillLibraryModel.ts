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
