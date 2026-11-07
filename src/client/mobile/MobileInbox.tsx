// Inbox on the phone: the same items and the same `/api/approvals/inbox/act` calls as the desktop
// Central chat (chat/needsYouApi), limited to approve once / deny / reply / snooze. "Always allow" and
// edits stay on the desktop: a permanent rule is not something to grant from a lock screen (K4).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
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

export function MobileInbox(props: { pollMs?: number }): React.JSX.Element {
  const { data, error, reload } = usePoll(() => request<{ items?: UnifiedItem[] }>(INBOX_ITEMS_PATH), props.pollMs ?? 4000)
  const [busy, setBusy] = useState<string | null>(null)
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null)
  const [actError, setActError] = useState<string | null>(null)
  const items = (data?.items ?? []).filter(shownHere)
  const hidden = (data?.items?.length ?? 0) - items.length

  const run = async (id: string, action: Action) => {
    setBusy(id)
    setActError(null)
    try {
      await actOn(id, action)
      setReply(null)
      reload()
    } catch (err) {
      setActError(inboxErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="m-screen" aria-label="Inbox">
      {error && <p className="m-error" role="alert">{error}</p>}
      {actError && <p className="m-error" role="alert">{actError}</p>}
      {data && items.length === 0 && <p className="m-empty">Nothing needs you right now.</p>}
      {items.map((item) => {
        const can = (a: string) => item.actions.includes(a as never)
        return (
          <article key={item.id} className={`m-card m-kind-${item.kind}`}>
            <div className="m-card-kind">{KIND_LABEL[item.kind]}{item.count > 1 ? ` · ×${item.count}` : ''}</div>
            <h3 className="m-card-title">{item.title}</h3>
            {item.impact && <p className="m-card-meta">{impactText(item.impact)}</p>}
            {item.body && item.kind !== 'gate' && <p className="m-card-body">{item.body}</p>}
            {reply?.id === item.id ? (
              <div className="m-reply">
                <Textarea aria-label="Reply" value={reply.text} onChange={(e) => setReply({ id: item.id, text: e.target.value })} rows={3} />
                <div className="m-actions">
                  <Button type="button" className="m-btn m-primary" disabled={busy !== null || !reply.text.trim()} onClick={() => void run(item.id, { type: 'reply', text: reply.text })}>Send reply</Button>
                  <Button type="button" className="m-btn" onClick={() => setReply(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="m-actions">
                {can('approve') && <Button type="button" className="m-btn m-primary" disabled={busy !== null} onClick={() => void run(item.id, { type: 'approve' })}>{item.kind === 'gate' ? 'Approve once' : 'Approve'}</Button>}
                {can('deny') && <Button type="button" className="m-btn m-danger" disabled={busy !== null} onClick={() => void run(item.id, { type: 'deny' })}>Deny</Button>}
                {can('reply') && <Button type="button" className="m-btn" disabled={busy !== null} onClick={() => setReply({ id: item.id, text: '' })}>Reply</Button>}
                {can('snooze') && <Button type="button" className="m-btn" disabled={busy !== null} onClick={() => void run(item.id, { type: 'snooze', until: snoozeUntil('1h', Date.now()) })}>Snooze 1h</Button>}
              </div>
            )}
          </article>
        )
      })}
      {hidden > 0 && <p className="m-empty">{hidden} task review{hidden === 1 ? '' : 's'} need the desktop Inbox.</p>}
    </section>
  )
}
