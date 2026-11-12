// Inbox on the phone: the same items and the same `/api/approvals/inbox/act` calls as the desktop
// Central chat (chat/needsYouApi), limited to approve once / deny / reply / snooze. "Always allow" and
// edits stay on the desktop: a permanent rule is not something to grant from a lock screen (K4).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction, type Action as UiAction } from '@/components/ui/action'
import { Textarea } from '@/components/ui/textarea'
import { INBOX_ITEMS_PATH, impactText, snoozeUntil, type UnifiedItem } from '../chat/needsYouApi'
import { inboxErrorMessage } from '../inboxApi'
import { request } from '../inboxTransport'
import { usePoll } from './mobile.poll'

/** The only actions this screen offers, whatever the item allows. */
export const MOBILE_ACTIONS = ['approve', 'deny', 'reply', 'snooze'] as const
const PERMISSION_KIND = 'agent.permission'
const KIND_LABEL: Record<UnifiedItem['kind'], string> = { gate: 'Needs approval', question: 'Question', review: 'Review', notify: 'Update' }
/** Same rule as the desktop list: other ledger approvals need the APPROVE-phrase dialog there. */
const shownHere = (i: UnifiedItem): boolean => !(i.kind === 'gate' && i.source === 'approval' && i.approvalKind !== PERMISSION_KIND)

type Action = { type: 'approve' } | { type: 'deny' } | { type: 'reply'; text: string } | { type: 'snooze'; until: number }

export const actOn = (id: string, action: Action) =>
  request<Record<string, unknown>>(`${INBOX_ITEMS_PATH}/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) })

/** One inbox answer: busy while it posts, then the list reloads (the item leaves), or the failure with Retry. */
function useInboxAct(id: string, label: string, action: () => Action, done: () => void): UiAction<void> {
  return useAction(async () => { await actOn(id, action()); done() }, { label, failure: (err) => `${label} failed: ${inboxErrorMessage(err)}` })
}

function InboxCard({ item, done }: { item: UnifiedItem; done: () => void }): React.JSX.Element {
  const [reply, setReply] = useState<string | null>(null)
  const approve = useInboxAct(item.id, 'Approve', () => ({ type: 'approve' }), done)
  const deny = useInboxAct(item.id, 'Deny', () => ({ type: 'deny' }), done)
  const snooze = useInboxAct(item.id, 'Snooze', () => ({ type: 'snooze', until: snoozeUntil('1h', Date.now()) }), done)
  const send = useInboxAct(item.id, 'Send reply', () => ({ type: 'reply', text: reply ?? '' }), () => { setReply(null); done() })
  const busy = approve.busy || deny.busy || snooze.busy || send.busy
  const can = (a: string) => item.actions.includes(a as never)
  return (
    <article className={`m-card m-kind-${item.kind}`} aria-busy={busy}>
      <div className="m-card-kind">{KIND_LABEL[item.kind]}{item.count > 1 ? ` · ×${item.count}` : ''}</div>
      <h3 className="m-card-title">{item.title}</h3>
      {item.impact && <p className="m-card-meta">{impactText(item.impact)}</p>}
      {item.body && item.kind !== 'gate' && <p className="m-card-body">{item.body}</p>}
      {reply !== null ? (
        <div className="m-reply">
          <Textarea aria-label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
          <div className="m-actions">
            <ActionButton type="button" className="m-btn m-primary" disabled={busy || !reply.trim()} action={send} busyLabel="Sending…">Send reply</ActionButton>
            <Button type="button" className="m-btn" onClick={() => setReply(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="m-actions">
          {can('approve') && <ActionButton type="button" className="m-btn m-primary" disabled={busy} action={approve} busyLabel="Approving…">{item.kind === 'gate' ? 'Approve once' : 'Approve'}</ActionButton>}
          {can('deny') && <ActionButton type="button" className="m-btn m-danger" disabled={busy} action={deny} busyLabel="Denying…">Deny</ActionButton>}
          {can('reply') && <Button type="button" className="m-btn" disabled={busy} onClick={() => setReply('')}>Reply</Button>}
          {can('snooze') && <ActionButton type="button" className="m-btn" disabled={busy} action={snooze} busyLabel="Snoozing…">Snooze 1h</ActionButton>}
        </div>
      )}
      {[approve, deny, snooze, send].map((a) => <ActionResult key={a.label} action={a} />)}
    </article>
  )
}

export function MobileInbox(props: { pollMs?: number }): React.JSX.Element {
  const { data, error, reload } = usePoll(() => request<{ items?: UnifiedItem[] }>(INBOX_ITEMS_PATH), props.pollMs ?? 4000)
  const items = (data?.items ?? []).filter(shownHere)
  const hidden = (data?.items?.length ?? 0) - items.length

  return (
    <section className="m-screen" aria-label="Inbox">
      {error && <p className="m-error" role="alert">{error}</p>}
      {data && items.length === 0 && <p className="m-empty">Nothing needs you right now.</p>}
      {items.map((item) => <InboxCard key={item.id} item={item} done={reload} />)}
      {hidden > 0 && <p className="m-empty">{hidden} task review{hidden === 1 ? '' : 's'} need the desktop Inbox.</p>}
    </section>
  )
}
