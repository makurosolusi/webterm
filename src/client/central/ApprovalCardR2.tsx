// Approval cards. Everything shown (tool, args, tier, summary) comes from the SERVER's record of
// the call, never from model prose. R3 needs the typed phrase; R2 is one click.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { CONFIRM_PHRASE } from '../inboxApprovalDialog'
import { CL } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { ApprovalCard, CentralControlClient } from './centralControlTypes'
import { centralErrorMessage, useLoad } from './centralLoad'

export interface ApprovalCardProps {
  card: ApprovalCard
  onDecide: (card: ApprovalCard, approve: boolean) => Promise<void>
  /** Clock for the expiry check; injected in tests. */
  now?: () => number
}

/** One pending approval; R3 stays disabled until the exact phrase is typed. */
export default function ApprovalCardR2({ card, onDecide, now = Date.now }: ApprovalCardProps) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const phrase = card.confirmPhrase ?? CONFIRM_PHRASE
  const expired = card.expiresAt > 0 && card.expiresAt <= now()
  const needsTyped = card.tier === 'R3'
  const canApprove = !busy && !expired && (!needsTyped || typed === phrase)

  const decide = async (approve: boolean) => {
    if (approve && !canApprove) return
    setBusy(true)
    try {
      await onDecide(card, approve)
    } catch (err) {
      setError(centralErrorMessage(err, CL.actionFailed))
      setBusy(false)
    }
  }

  return (
    <article className="ccp-card" aria-label={`${card.tool} ${card.tier}`} data-tier={card.tier}>
      <header>
        <strong>{card.tool}</strong>
        <span className="ccp-badge" aria-label={`${CL.tier} ${card.tier}`}>{card.tier}</span>
        {expired && <span className="ccp-badge ccp-badge--warn">{CL.expired}</span>}
      </header>
      <p className="ccp-summary" data-testid="server-summary" aria-label={CL.summary}>{card.summary}</p>
      {card.args.length > 0 && (
        <dl className="ccp-kv" aria-label={CL.arguments}>
          {card.args.map((a) => (<div key={a.key} className="ccp-kv__row"><dt>{a.key}</dt><dd>{a.value}</dd></div>))}
        </dl>
      )}
      {needsTyped && (
        <label className="ccp-confirm-input">{CL.confirmLabel(phrase)}
          <Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      <footer>
        <Button type="button" size="sm" disabled={!canApprove} onClick={() => void decide(true)}>{CL.approve}</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}>{CL.reject}</Button>
      </footer>
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </article>
  )
}

export interface ApprovalQueueProps { client?: CentralControlClient; now?: () => number }

/** Pending approval list; a decided card disappears after the list reloads. */
export function ApprovalQueue({ client = centralControlApi, now }: ApprovalQueueProps) {
  const list = useLoad((s) => client.listApprovals(s))
  const { reload } = list
  const decide = async (card: ApprovalCard, approve: boolean) => { await client.decide(card, approve); reload() }
  return (
    <section className="ccp-section" aria-labelledby="ccp-appr-h">
      <h3 id="ccp-appr-h">{CL.approvalsHeading}</h3>
      {list.error && <p role="alert" className="ccp-error">{list.error}</p>}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {list.data?.length === 0 && <p>{CL.empty}</p>}
      {list.data?.map((card) => <ApprovalCardR2 key={card.id} card={card} onDecide={decide} {...(now ? { now } : {})} />)}
    </section>
  )
}
