// Display pieces of a skill-author chat (preset 'skill-author'): locked-role header, empty state with click-to-fill
// starters, and the "draft proposed" card. Nothing here is ever sent to the model.
import { IconTooltip } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { openSideBarView } from '../sideBar/sideBar.open'
import type { AgentChatState } from './agentChatStore'
import { SKILL_AUTHOR_BANNER, SKILL_AUTHOR_DRAFT, SKILL_AUTHOR_EMPTY, SKILL_AUTHOR_HEADER, SKILL_AUTHOR_LOCK_REASON } from './skillAuthor.preset'

/** Role strip: lock icon + short role line; the tooltip carries the reason, screen readers get the full banner. */
export function SkillAuthorHeader() {
  return (
    <div className="agent-chat-banner" role="note" aria-label="Chat role">
      <IconTooltip label={SKILL_AUTHOR_LOCK_REASON} side="bottom">
        <span className="skill-author__role" tabIndex={0}>
          <span className="codicon codicon-lock" aria-hidden="true" />
          <span>{SKILL_AUTHOR_HEADER}</span>
        </span>
      </IconTooltip>
      <span className="sr-only">{SKILL_AUTHOR_BANNER}</span>
    </div>
  )
}

/** Shown while the thread is empty: three starters that fill the composer (the user still presses Send). */
export function SkillAuthorEmpty({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="skill-author__empty">
      <p className="chat-empty">{SKILL_AUTHOR_EMPTY.title}</p>
      <p className="agent-chat-muted">{SKILL_AUTHOR_EMPTY.hint}</p>
      <ul className="skill-author__examples" aria-label="Starters">
        {SKILL_AUTHOR_EMPTY.examples.map((text) => (
          <li key={text}><Button type="button" variant="outline" size="sm" className="skill-author__example" onClick={() => onPick(text)}>{text}</Button></li>
        ))}
      </ul>
    </div>
  )
}

const PROPOSE = /\bwebterm\s+skills\s+(propose|edit)\b/

/** True once a `webterm skills propose|edit` call of this chat finished without error or denial. */
export function proposedDraft(state: Pick<AgentChatState, 'tools'>): boolean {
  return Object.values(state.tools).some((t) => {
    const cmd = (t.input as { command?: unknown } | null)?.command
    return t.name === 'Bash' && t.state === 'done' && typeof cmd === 'string' && PROPOSE.test(cmd)
  })
}

/** Inline status card: a draft is waiting for review; the button opens the Skills panel of the canvas side bar, where the draft is approved. */
export function SkillAuthorDraftCard() {
  return (
    <div className="skill-author__draft" role="status">
      <span className="codicon codicon-check" aria-hidden="true" />
      <span>{SKILL_AUTHOR_DRAFT.text}</span>
      <Button type="button" size="xs" variant="secondary" onClick={() => openSideBarView('skills')}>{SKILL_AUTHOR_DRAFT.open}</Button>
    </div>
  )
}
