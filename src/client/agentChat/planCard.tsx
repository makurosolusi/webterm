// ExitPlanMode card (PLAN/AGENT-CHAT.md D8): the plan as Markdown, Approve with the mode to continue
// in (as the Claude Code prompt: auto-accept edits / manually approve edits), or Keep planning with
// feedback, which goes back to Claude as the deny message.
import { useId, useRef, useState } from 'react'
import { RadioGroup } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import ChatMarkdown from '../chat/chatMarkdown'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { PlanCardProps } from './agentChatCards.types'
import { AnswerError, ResolvedBadge, Spinner, useAnswerAction } from './permissionCard'
import { ChoiceRow, Radio } from './questionCard'
import { rec, str } from './toolCards'
import './agentChatCards.css'

/** Sent to Claude when the user keeps planning without writing feedback. */
export const KEEP_PLANNING_MESSAGE = 'The user wants to keep planning.'

/** Modes offered after approval, first = preselected (Claude Code's order). */
export const PLAN_NEXT_MODES: { mode: AgentPermissionMode; label: string }[] = [
  { mode: 'acceptEdits', label: 'Yes, and auto-accept edits' },
  { mode: 'manual', label: 'Yes, and manually approve edits' },
  { mode: 'bypassPermissions', label: 'Yes, and bypass permissions' },
]

/** Card of an ExitPlanMode request (`kind: 'plan'`). */
export function PlanCard({ request, outcome, answer, setMode }: PlanCardProps) {
  const plan = str(rec(request.input).plan)
  const [next, setNext] = useState<AgentPermissionMode>(PLAN_NEXT_MODES[0].mode)
  const [feedback, setFeedback] = useState('')
  const base = useId()
  const { pending, error, run, retry } = useAnswerAction()
  // A retry after a failed setMode must not answer the (already settled) request again.
  const answered = useRef(false)
  const approve = () => {
    const mode = next
    return run(async () => {
      if (!answered.current) {
        await answer({ requestId: request.requestId, behavior: 'allow', updatedInput: rec(request.input) })
        answered.current = true
      }
      await setMode(mode)
    })
  }
  const keepPlanning = () => run(() => answer({ requestId: request.requestId, behavior: 'deny', message: feedback.trim() || KEEP_PLANNING_MESSAGE }))
  const open = outcome === 'open'
  return (
    <div className="acc-card acc-plan" data-outcome={outcome} role="group" aria-label="Plan ready for review">
      <div className="acc-permission__head">
        <span className="codicon codicon-checklist" aria-hidden="true" />
        <span className="acc-permission__title">Ready to code? Here is Claude&apos;s plan:</span>
        {!open && <ResolvedBadge outcome={outcome} />}
      </div>
      <div className="acc-plan__body">{plan ? <ChatMarkdown source={plan} /> : <span className="acc-muted">The plan is empty.</span>}</div>
      {open && (
        <>
          <fieldset className="acc-question" disabled={pending}>
            <legend className="acc-question__legend">Would you like to proceed?</legend>
            <RadioGroup.Root className="acc-question" aria-label="Mode after approval" disabled={pending} value={next}
              onValueChange={(v) => { const m = PLAN_NEXT_MODES.find((o) => o.mode === v); if (m) setNext(m.mode) }}>
              {PLAN_NEXT_MODES.map((o) => (
                <ChoiceRow key={o.mode} id={`${base}-${o.mode}`} label={o.label}>
                  <Radio id={`${base}-${o.mode}`} value={o.mode} disabled={pending} />
                </ChoiceRow>
              ))}
            </RadioGroup.Root>
          </fieldset>
          <div className="acc-row">
            {pending && <Spinner />}
            <Button size="xs" disabled={pending} onClick={() => void approve()}>Approve</Button>
          </div>
          <Textarea aria-label="Feedback on the plan" placeholder="Tell Claude what to change (sent with Keep planning)"
            rows={2} value={feedback} disabled={pending || answered.current} onChange={(e) => setFeedback(e.target.value)} />
          <div className="acc-row">
            <Button variant="secondary" size="xs" disabled={pending || answered.current} onClick={() => void keepPlanning()}>Keep planning</Button>
          </div>
        </>
      )}
      {/* Outside `open`: the request settles before setMode runs, and a failed setMode still needs Retry. */}
      {error && <AnswerError error={error} retry={retry} disabled={pending} />}
    </div>
  )
}
