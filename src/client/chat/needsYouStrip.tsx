// "N need you" strip at the top of the Central chat: the one place that replaces the Inbox panel.
// Collapsed it is a single line with a chip per category; expanded it lists every waiting item.
// Unified items decide inline (`ChatApprovalCard`); task reviews and other ledger approvals open
// the Inbox's APPROVE-phrase dialog (`useTaskReview`). Hidden when nothing waits. It needs only
// ledger endpoints, so it renders when Central is off.
import { useState } from 'react'
import type { InboxClient, InboxItem } from '../inboxApi'
import { ChatApprovalCard } from './chatApprovalCard'
import { needsYouRows, useNeedsYou, type UnifiedItem } from './needsYouApi'
import { useTaskReview } from './needsYouReview'
import './needsYou.css'

export type NeedsYouCategory = 'approvals' | 'review' | 'broken'
const CATEGORY_LABEL: Record<NeedsYouCategory, string> = { approvals: 'Approvals', review: 'Review', broken: 'Broken' }
const ORDER: readonly NeedsYouCategory[] = ['approvals', 'review', 'broken']

const cardCategory = (item: UnifiedItem): NeedsYouCategory => (item.kind === 'gate' ? 'approvals' : 'review')
const taskCategory = (item: InboxItem): NeedsYouCategory => (item.state === 'needs_you' ? 'approvals' : item.state)

export interface NeedsYouStripProps {
  /** Task review API; the default is the real inbox client. Injected in tests. */
  client?: InboxClient
  now?: () => number
}

export function NeedsYouStrip(props: NeedsYouStripProps): React.JSX.Element | null {
  const { cards, tasks } = needsYouRows(useNeedsYou())
  const [expanded, setExpanded] = useState(false)
  const review = useTaskReview({ client: props.client, now: props.now })
  const total = cards.length + tasks.length
  if (total === 0 && !review.dialog) return null

  const counts: Record<NeedsYouCategory, number> = { approvals: 0, review: 0, broken: 0 }
  for (const c of cards) counts[cardCategory(c)] += 1
  for (const t of tasks) counts[taskCategory(t)] += 1

  return (
    <section className="needs-strip" aria-label="Needs you">
      {total > 0 && (
        <button type="button" className="needs-strip__head" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden="true" />
          <span className="needs-strip__total">{total} need{total === 1 ? 's' : ''} you</span>
          {ORDER.filter((c) => counts[c] > 0).map((c) => (
            <span key={c} className="needs-strip__chip" data-category={c}>{CATEGORY_LABEL[c]} {counts[c]}</span>
          ))}
        </button>
      )}
      {expanded && total > 0 && (
        <ul className="needs-strip__list">
          {cards.map((item) => (
            <li key={item.id} data-category={cardCategory(item)}><ChatApprovalCard approvalId={item.id} now={props.now} /></li>
          ))}
          {tasks.map((item) => {
            const blocked = review.blocked(item)
            return (
              <li key={item.id} className="needs-task" data-category={taskCategory(item)}>
                <span className="needs-card__title">{item.title}</span>
                <span className="needs-card__summary">{[CATEGORY_LABEL[taskCategory(item)], item.projectId, item.detail].filter(Boolean).join(' · ')}</span>
                <button type="button" className="chat-retry needs-task__open" aria-label={`Review ${item.title}`} disabled={blocked !== null}
                  title={blocked ?? undefined} onClick={() => review.open(item)}>Review</button>
              </li>
            )
          })}
        </ul>
      )}
      {review.dialog}
    </section>
  )
}
