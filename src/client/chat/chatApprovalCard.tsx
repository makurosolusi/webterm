// Inline decision card for one unified inbox item, keyed by its id (a gate's id IS its approvalId).
// Rendered for Central `approval` message parts and for every card row of the "Needs you" strip.
// It reads the shared needs-you snapshot (no poller of its own) and answers through
// `POST /api/approvals/inbox/act` (human-only route). An R3 gate (cannot be rewound) keeps the
// typed APPROVE phrase. The message part's state (live `approval.*` frames) settles the card.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, useAction } from '@/components/ui/action'
import { IconTooltip } from '@/components/ui/icon-button'
import { Textarea } from '@/components/ui/textarea'
import { InboxApiError, inboxErrorMessage } from '../inboxApi'
import { CONFIRM_PHRASE } from '../inboxApprovalDialog'
import type { ChatToolState } from './chatTypes'
import {
  actOnItem, approveLabel, impactText, refreshNeedsYou, snoozeUntil, useNeedsYou,
  type Action, type ActionType, type UnifiedItem,
} from './needsYouApi'
import './needsYou.css'

const SUMMARY_MAX = 400

/** Part state → final label; null while the approval is still open. */
export function settledFromPart(state: ChatToolState | undefined): string | null {
  if (state === 'succeeded') return 'Approved'
  if (state === 'denied' || state === 'failed') return 'Denied'
  if (state === 'cancelled') return 'Expired'
  return null
}

const RESOLUTION_LABEL: Record<string, string> = {
  approved: 'Approved', accepted: 'Accepted', denied: 'Denied', replied: 'Replied', ignored: 'Ignored',
}

export interface ChatApprovalCardProps {
  /** Inbox item id; for a gate this is the ledger approvalId. */
  approvalId: string
  /** State of the Central message part, updated live by `approval.*` frames. */
  partState?: ChatToolState
  /** Clock for snooze presets; injected in tests. */
  now?: () => number
}

export function ChatApprovalCard(props: ChatApprovalCardProps): React.JSX.Element {
  const { items, itemsLoaded, error: listError } = useNeedsYou()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<{ message: string; action: Action | null } | null>(null)
  const [draft, setDraft] = useState<{ mode: 'edit' | 'reply'; text: string } | null>(null)
  const [phrase, setPhrase] = useState('')
  const now = props.now ?? Date.now
  const item = items.find((i) => i.id === props.approvalId)
  const lastItem = useRef<UnifiedItem | undefined>(item)
  if (item) lastItem.current = item
  const title = lastItem.current?.title ?? 'Approval request'

  // Refetch on mount and whenever a live frame moves the part: the server list is the truth.
  useEffect(() => { void refreshNeedsYou() }, [props.partState])
  // Retry of a list that never loaded: busy while it refetches; the result is the card itself (or the same error line).
  const reload = useAction(refreshNeedsYou, { label: 'Load approval', toast: 'never' })

  const act = async (action: Action): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await actOnItem(props.approvalId, action)
      setOutcome(action.type === 'snooze' ? 'Snoozed' : RESOLUTION_LABEL[res?.resolution ?? ''] ?? 'Done')
      setDraft(null)
    } catch (err) {
      // Lost the race (Telegram, another tab, the hook's expiry): not an error the human can fix.
      if (err instanceof InboxApiError && err.status === 409 && (err.code === 'not_open' || err.code === 'not_pending')) setOutcome('Answered elsewhere')
      else if (err instanceof InboxApiError && err.status === 404) setOutcome('Expired')
      else setError({ message: inboxErrorMessage(err), action })
    } finally {
      setBusy(false)
    }
  }
  // The card carries the feedback of every answer: aria-busy + "Sending…" while it runs, then the settled
  // badge, or the error line with Retry. `send` only starts it.
  const send = (action: Action): void => { void act(action) }

  const settled = outcome ?? settledFromPart(props.partState) ?? (itemsLoaded && !item ? 'Expired' : null)
  if (settled !== null) {
    return (
      <div className="needs-card" data-state="settled" aria-label={`${title}: ${settled}`}>
        <span className="needs-card__title">{title}</span>
        <span className="needs-card__badge">{settled}</span>
      </div>
    )
  }
  if (!item) {
    return (
      <div className="needs-card" data-state={listError ? 'error' : 'loading'}>
        {listError ? (
          <span role="alert" className="needs-card__error">
            {listError} <ActionButton size="sm" variant="secondary" action={reload} busyLabel="Retrying…">Retry</ActionButton>
          </span>
        ) : <span role="status">Loading approval…</span>}
      </div>
    )
  }

  const can = (a: ActionType): boolean => item.actions.includes(a)
  const r3 = item.impact?.tier === 'R3'
  const confirmed = !r3 || phrase === CONFIRM_PHRASE
  const summary = item.body && item.body.length > SUMMARY_MAX ? `${item.body.slice(0, SUMMARY_MAX)}…` : item.body
  return (
    <div className="needs-card" data-state={busy ? 'deciding' : 'pending'} data-kind={item.kind} aria-busy={busy || undefined}>
      <span className="needs-card__title">{item.title}{item.count > 1 ? ` (×${item.count})` : ''}</span>
      {item.impact && <span className="needs-card__impact" data-tier={item.impact.tier}>{impactText(item.impact)}</span>}
      {summary && <span className="needs-card__summary">{summary}</span>}
      {r3 && can('approve') && (
        <label className="needs-card__phrase">
          <span>Cannot be rewound. Type {CONFIRM_PHRASE} to confirm</span>
          <input type="text" aria-label={`Type ${CONFIRM_PHRASE} to confirm`} autoComplete="off" spellCheck={false}
            value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
      )}
      <div className="needs-card__actions">
        {can('approve') && <Button size="sm" disabled={busy || !confirmed} onClick={() => send({ type: 'approve' })}>{approveLabel(item)}</Button>}
        {can('deny') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => send({ type: 'deny' })}>Deny</Button>}
        {can('always') && (
          <IconTooltip label="Saves a permanent rule (only from this window, never from Telegram)" disabled={busy || !confirmed} disabledReason="confirm first">
            <Button size="sm" variant="secondary" disabled={busy || !confirmed} onClick={() => send({ type: 'always' })}>Always</Button>
          </IconTooltip>
        )}
        {can('edit') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft({ mode: 'edit', text: JSON.stringify(item.args ?? null, null, 2) })}>Edit</Button>}
        {can('reply') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft({ mode: 'reply', text: '' })}>Reply</Button>}
        {can('snooze') && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Snooze ${item.title} for 1 hour`} onClick={() => send({ type: 'snooze', until: snoozeUntil('1h', now()) })}>Snooze 1h</Button>}
        {can('snooze') && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Snooze ${item.title} until tomorrow`} onClick={() => send({ type: 'snooze', until: snoozeUntil('tomorrow', now()) })}>Tomorrow</Button>}
        {can('ignore') && <Button size="sm" variant="ghost" disabled={busy} onClick={() => send({ type: 'ignore' })}>{item.kind === 'notify' ? 'Dismiss' : 'Ignore'}</Button>}
      </div>
      {busy && <span role="status" className="needs-card__status">Sending…</span>}
      {error && (
        <span role="alert" className="needs-card__error">
          {error.message} {error.action && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (error.action) send(error.action) }}>Retry</Button>}
        </span>
      )}
      {draft && <ItemDraft key={draft.mode} draft={draft} busy={busy || (draft.mode === 'edit' && !confirmed)}
        onText={(text) => setDraft({ ...draft, text })} onCancel={() => setDraft(null)}
        onSubmit={() => {
          if (draft.mode === 'reply') return send({ type: 'reply', text: draft.text })
          try { send({ type: 'edit', args: JSON.parse(draft.text) as unknown }) } catch { setError({ message: 'The edited arguments are not valid JSON.', action: null }) }
        }} />}
    </div>
  )
}

/** Reply text or the JSON args editor (also what a PR review draft is edited in). */
export function ItemDraft(props: { draft: { mode: 'edit' | 'reply'; text: string }; busy: boolean; onText(t: string): void; onSubmit(): void; onCancel(): void }) {
  const reply = props.draft.mode === 'reply'
  return (
    <span style={{ flexBasis: '100%', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
      <Textarea aria-label={reply ? 'Reply to the agent' : 'Edit arguments'} rows={reply ? 2 : 4} style={{ flex: 1, fontFamily: reply ? undefined : 'monospace' }}
        value={props.draft.text} onChange={(e) => props.onText(e.target.value)} />
      <Button size="sm" disabled={props.busy || props.draft.text.trim() === ''} onClick={props.onSubmit}>{reply ? 'Send reply' : 'Approve with edits'}</Button>
      <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
    </span>
  )
}
