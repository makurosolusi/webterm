// One inbox list row (presentational). Split out of `InboxPanel` so the panel stays well inside
// the repo's 500-line hard cap. It renders no fetches and owns no state: the panel passes the
// already-matched resume approval, readiness of the approved list, and the selection callbacks.
//
// Gating rule while the approved list is still loading: a task row's Review action is disabled
// (title "Checking existing approvals…") because minting consent before we know whether an
// approved-but-unconsumed one exists is exactly the duplicate-approval bug (QC B4). Approval-kind
// rows and non-task rows are never gated.
import type { ApprovedApproval, InboxItem } from './inboxApi'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SECTION_LABEL, formatAge, reviewBlockedReason } from './inboxPanelModel'

export interface InboxItemRowProps {
  item: InboxItem
  selected: boolean
  /** Matching approved-unconsumed consent for this row, or null. */
  resume: ApprovedApproval | null
  /** False while the approved list has not produced a result yet (task rows only). */
  ready: boolean
  onToggleSelected: (id: string) => void
  onOpen: () => void
}

export function InboxItemRow(props: InboxItemRowProps): React.JSX.Element {
  const { item, selected, resume, ready, onToggleSelected, onOpen } = props
  const blocked = reviewBlockedReason(item)
  const checking = item.kind === 'task' && !ready
  return (
    <li className="inbox-item">
      <Checkbox className="inbox-check" aria-label={`Select ${item.title}`}
        checked={selected} onCheckedChange={() => onToggleSelected(item.id)} />
      <div className="inbox-item__body">
        <div className="inbox-item__top">
          <span className={`inbox-state inbox-state--${item.state}`}>{SECTION_LABEL[item.state]}</span>
          <span className="inbox-item__title">{item.title}</span>
          <span className="inbox-item__age" title={`${item.ageMs} ms ago`}>{formatAge(item.ageMs)} ago</span>
        </div>
        <div className="inbox-item__meta">
          <span className="inbox-item__kind">{item.kind}</span>
          <span aria-hidden="true">·</span>
          <span className="inbox-item__project">{item.projectId}</span>
        </div>
        {item.detail && <p className="inbox-item__detail">{item.detail}</p>}
        <div className="inbox-item__actions">
          {resume ? (
            <Button type="button" variant="ghost" className="inbox-btn inbox-btn--ghost"
              aria-label={`Finish approval for ${item.title}`}
              onClick={onOpen}>
              Finish approval
            </Button>
          ) : (
            <Button type="button" variant="ghost" className="inbox-btn inbox-btn--ghost"
              aria-label={`Review ${item.title}`}
              title={checking ? 'Checking existing approvals…' : blocked ?? undefined}
              disabled={checking || blocked !== null}
              onClick={onOpen}>
              Review
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
