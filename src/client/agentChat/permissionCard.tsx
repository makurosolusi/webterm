// Tool permission request card (PLAN/AGENT-CHAT.md D7), modelled on the Claude Code VS Code prompt:
// Allow once / Always allow / Deny with an optional note. Also home of the pending/error/retry hook
// and the resolved badge that the question and plan cards share.
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PermissionCardProps, PermissionOutcome } from './agentChatCards.types'
import { errorText, rec, toolSummary } from './toolCards'
import './agentChatCards.css'

/** Sent to Claude when the user denies without writing a note. */
export const DEFAULT_DENY_MESSAGE = 'The user denied this tool use.'

const OUTCOME_LABEL: Record<Exclude<PermissionOutcome, 'open'>, string> = {
  allow: 'Allowed', deny: 'Denied', cancelled: 'Cancelled', expired: 'Expired',
}

/** Read-only badge of a settled request. */
export function ResolvedBadge({ outcome }: { outcome: Exclude<PermissionOutcome, 'open'> }) {
  return <span className={`acc-badge acc-badge--${outcome}`} role="status">{OUTCOME_LABEL[outcome]}</span>
}

/** Runs one answer action at a time; keeps the last action so a failed POST can be retried as-is. */
export function useAnswerAction(): { pending: boolean; error: string | undefined; run: (act: () => Promise<void>) => Promise<void>; retry: () => void } {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const last = useRef<() => Promise<void>>(undefined)
  const run = useCallback(async (act: () => Promise<void>) => {
    last.current = act
    setPending(true)
    setError(undefined)
    try { await act() } catch (e) { setError(errorText(e)) } finally { setPending(false) }
  }, [])
  const retry = useCallback(() => { if (last.current) void run(last.current) }, [run])
  return { pending, error, run, retry }
}

/** Inline failure line with Retry, shown under a card's buttons. */
export function AnswerError({ error, retry, disabled }: { error: string; retry: () => void; disabled: boolean }) {
  return (
    <div className="acc-row" role="alert">
      <span className="acc-error">{`Could not send your answer: ${error}`}</span>
      <Button variant="secondary" size="xs" disabled={disabled} onClick={retry}>Retry</Button>
    </div>
  )
}

export const Spinner = () => <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />

/** Permission card of one `canUseTool` request (`kind: 'tool'`). */
export function PermissionCard({ request, outcome, answer }: PermissionCardProps) {
  const { pending, error, run, retry } = useAnswerAction()
  const [note, setNote] = useState('')
  const summary = toolSummary(request.toolName, request.input)
  const canAlways = (request.suggestions?.length ?? 0) > 0
  const allow = (always: boolean) => run(() => answer({
    requestId: request.requestId, behavior: 'allow', updatedInput: rec(request.input), ...(always ? { always: true } : {}),
  }))
  const deny = () => run(() => answer({ requestId: request.requestId, behavior: 'deny', message: note.trim() || DEFAULT_DENY_MESSAGE }))
  const open = outcome === 'open'
  return (
    <div className="acc-card acc-permission" data-outcome={outcome} aria-label={`Permission request for ${request.toolName}`} role="group">
      <div className="acc-permission__head">
        <span className="codicon codicon-shield" aria-hidden="true" />
        <span className="acc-permission__title">{request.title ?? `Allow ${request.toolName}?`}</span>
        {!open && <ResolvedBadge outcome={outcome} />}
      </div>
      {summary && <div className="acc-code acc-permission__summary">{summary}</div>}
      {request.description && <div className="acc-muted">{request.description}</div>}
      {open && (
        <>
          <Textarea aria-label="Tell Claude what to do instead" placeholder="Tell Claude what to do instead (optional, sent with Deny)"
            rows={1} value={note} disabled={pending} onChange={(e) => setNote(e.target.value)} />
          <div className="acc-row">
            {pending && <Spinner />}
            <Button size="xs" disabled={pending} onClick={() => void allow(false)}>Allow once</Button>
            {canAlways && <Button variant="secondary" size="xs" disabled={pending} onClick={() => void allow(true)}>Always allow</Button>}
            <Button variant="secondary" size="xs" disabled={pending} onClick={() => void deny()}>Deny</Button>
          </div>
          {error && <AnswerError error={error} retry={retry} disabled={pending} />}
        </>
      )}
    </div>
  )
}
