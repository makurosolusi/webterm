// Audience of a skill in the UI: a badge for rows and cards.
import type { SkillAudience } from '../../server/central/contracts/skill.types'
import { CL } from './centralLabels'

/** Short badge (Central / Canvas) with the one-line meaning as its tooltip text. */
export function AudienceBadge({ audience }: { audience: SkillAudience }) {
  return <span className="ccp-badge" title={CL.skillAudienceHelp[audience]}>{CL.skillAudienceBadge[audience]}</span>
}
