// Pure helpers of the skill-author drafts panel. No React.
import type { SkillReviewRow } from './centralControlTypes'

const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']

/** `proposedBy` the server stores for a proposal made from the Agent Chat node `nodeId`. */
export const proposerOf = (nodeId: string): string => `agent:${nodeId}`

/** Open (still undecided) drafts that this chat node proposed; every other row is not this agent's. */
export const draftsOf = (rows: readonly SkillReviewRow[], nodeId: string): SkillReviewRow[] =>
  rows.filter((r) => r.record.proposedBy === proposerOf(nodeId) && OPEN.includes(r.record.status))
