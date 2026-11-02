// One inbox list row (presentational). Split out of `InboxPanel` so the panel stays well inside
// the repo's 500-line hard cap. It renders no fetches and owns no state: the panel passes the
// already-matched resume approval, readiness of the approved list, and the selection callbacks.
//
// Gating rule while the approved list is still loading: a task row's Review action is disabled
// (title "Checking existing approvals…") because minting consent before we know whether an
// approved-but-unconsumed one exists is exactly the duplicate-approval bug (QC B4). Approval-kind
// rows and non-task rows are never gated.
import type { ApprovedApproval, InboxItem, InboxState } from './inboxApi'
import { SECTION_LABEL, formatAge, reviewBlockedReason } from './inboxPanelModel'

/** Problems-view severity icon per inbox state (broken = error, needs you = warning, review = info). */
export const STATE_ICON: Record<InboxState, string> = {
  needs_you: 'warning',
  review: 'info',
  broken: 'error',
}

export interface InboxItemRowProps {
  item: InboxItem
  selected: boolean
  /** Matching approved-unconsumed consent for this row, or null. */
  resume: ApprovedApproval | null
  /** False while the approved list has not produced a result yet (task rows only). */
  ready: boolean
  /** Roving tabindex: 0 for the single list stop, -1 otherwise. */
  tabIndex: 0 | -1
  onToggleSelected: (id: string) => void
  onOpen: () => void
}

/** Description column: `kind · project`, then the server detail when present. */
function describe(item: InboxItem): string {
  const base = `${item.kind} · ${item.projectId}`
  return item.detail ? `${base} · ${item.detail}` : base
}

/** One 22px Problems-view row: select box, severity icon, title, dimmed description, age, action. */
export function InboxItemRow(props: InboxItemRowProps): React.JSX.Element {
  const { item, selected, resume, ready, tabIndex, onToggleSelected, onOpen } = props
  const blocked = reviewBlockedReason(item)
  const checking = item.kind === 'task' && !ready
  const description = describe(item)
  return (
    <li className="inbox-item" data-row-key={`r:${item.id}`} data-selected={selected ? 'true' : 'false'}
      tabIndex={tabIndex} title={description}>
      <input type="checkbox" className="inbox-check" tabIndex={-1} aria-label={`Select ${item.title}`}
        checked={selected} onChange={() => onToggleSelected(item.id)} />
      <span className={`codicon codicon-${STATE_ICON[item.state]} inbox-state inbox-state--${item.state}`}
        role="img" aria-label={SECTION_LABEL[item.state]} />
      <span className="inbox-item__title">{item.title}</span>
      <span className="inbox-item__desc">{description}</span>
      <span className="inbox-item__age" title={`${item.ageMs} ms ago`}>{formatAge(item.ageMs)} ago</span>
      {resume ? (
        <button type="button" className="inbox-action" tabIndex={-1} data-inbox-open
          aria-label={`Finish approval for ${item.title}`} onClick={onOpen}>
          Finish approval
        </button>
      ) : (
        <button type="button" className="inbox-action" tabIndex={-1} data-inbox-open
          aria-label={`Review ${item.title}`}
          title={checking ? 'Checking existing approvals…' : blocked ?? undefined}
          disabled={checking || blocked !== null}
          onClick={onOpen}>
          Review
        </button>
      )}
    </li>
  )
}
