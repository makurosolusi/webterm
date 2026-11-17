// What the Central skill-author chat shows about itself: a compact role banner above the thread and a composer chip.
// Display only: neither is ever sent to the model as a message.
import { CL } from './centralLabels'
import './central.css'

/** Purpose, tool limit and the approval rule, plus the skill being edited when there is one. */
export function CentralSkillAuthorBanner({ target }: { target?: string | null }) {
  return (
    <aside className="ccp-author-banner" aria-label={CL.authorBannerLabel}>
      <strong>{CL.authorBannerTitle}</strong>
      <span>{CL.authorBannerPurpose}</span>
      <span>{CL.authorBannerTools}</span>
      <span>{CL.authorBannerDrafts}</span>
      {target && <span>{CL.authorBannerTarget(target)}</span>}
    </aside>
  )
}

/** The composer's restricted state: this chat can only work with skills. */
export function CentralSkillAuthorChip() {
  return <span className="ccp-badge" title={CL.authorChipHelp}>{CL.authorChip}</span>
}
