// Pure helpers of the skill-author drafts panel. No React.
import type { SkillReviewRow } from './centralControlTypes'

const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']

/** Open drafts Central's author chat proposed for Central skills (Control > Skills Drafts panel); canvas drafts show in the canvas Skills panel. */
export const centralDraftsOf = (rows: readonly SkillReviewRow[]): SkillReviewRow[] =>
  rows.filter((r) => r.record.origin === 'central' && r.record.audience === 'central' && OPEN.includes(r.record.status))
