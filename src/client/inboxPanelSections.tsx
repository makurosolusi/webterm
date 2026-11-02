// Presentational section list for `InboxPanel`: per-state collapsible sections, select-all
// checkbox, and the item rows. Split out to keep the container inside the file-size budget.
// It owns no state and performs no fetching: the panel passes the visible rows, selection,
// collapse state, and approved-resume lookup results.
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { ApprovedApproval, InboxItem, InboxState } from './inboxApi'
import { InboxItemRow } from './inboxItemRow'
import { SECTION_LABEL, SECTION_ORDER, resumeApprovalFor } from './inboxPanelModel'
import type { InboxFilter } from './inboxPanelChrome'

export interface InboxPanelSectionsProps {
  uid: string
  filter: InboxFilter
  visible: readonly InboxItem[]
  collapsed: ReadonlySet<InboxState>
  selected: ReadonlySet<string>
  approved: readonly ApprovedApproval[]
  approvedReady: boolean
  onToggleSection: (state: InboxState) => void
  onSelectSection: (rows: InboxItem[], select: boolean) => void
  onToggleSelected: (id: string) => void
  onOpen: (item: InboxItem) => void
}

export function InboxPanelSections(props: InboxPanelSectionsProps): React.JSX.Element {
  const {
    uid, filter, visible, collapsed, selected, approved, approvedReady,
    onToggleSection, onSelectSection, onToggleSelected, onOpen,
  } = props
  return (
    <div className="inbox-sections">
      {SECTION_ORDER.map((state) => {
        const rows = visible.filter((item) => item.state === state)
        if (filter === 'all' && rows.length === 0) return null
        if (filter !== 'all' && filter !== state) return null
        const isCollapsed = collapsed.has(state)
        const bodyId = `${uid}-section-${state}`
        const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))
        return (
          <section className="inbox-section" key={state} aria-labelledby={`${uid}-section-head-${state}`}>
            <header className="inbox-section__head">
              <Checkbox className="inbox-check"
                aria-label={`Select all in ${SECTION_LABEL[state]}`}
                checked={allSelected} disabled={rows.length === 0}
                onCheckedChange={(checked) => onSelectSection(rows, checked === true)} />
              <Button type="button" variant="ghost" className="inbox-section__toggle" id={`${uid}-section-head-${state}`}
                aria-expanded={!isCollapsed} aria-controls={bodyId} onClick={() => onToggleSection(state)}>
                {isCollapsed
                  ? <ChevronRight size={13} aria-hidden="true" />
                  : <ChevronDown size={13} aria-hidden="true" />}
                <span>{SECTION_LABEL[state]}</span>
                <span className="inbox-count">{rows.length}</span>
              </Button>
            </header>
            {!isCollapsed && (
              <div id={bodyId}>
                {rows.length === 0 ? (
                  <p className="inbox-section__empty">Nothing in this section.</p>
                ) : (
                  <ul className="inbox-list">
                    {rows.map((item) => (
                      <InboxItemRow key={item.id} item={item} selected={selected.has(item.id)}
                        resume={resumeApprovalFor(item, approved)} ready={approvedReady}
                        onToggleSelected={onToggleSelected} onOpen={() => onOpen(item)} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
