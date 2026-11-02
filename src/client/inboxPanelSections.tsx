// Presentational section list for `InboxPanel`: per-state collapsible groups (Problems-view
// style: twistie, label, count badge), select-all checkbox, and the item rows. Split out to keep
// the container inside the file-size budget. It performs no fetching; its only state is the
// roving-focus row (`useInboxListKeys`). The panel passes the visible rows, selection, collapse
// state, and approved-resume lookup results.
import type { ApprovedApproval, InboxItem, InboxState } from './inboxApi'
import { InboxItemRow } from './inboxItemRow'
import { headerKey, useInboxListKeys } from './inboxListKeys'
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
  const groups = SECTION_ORDER
    .map((state) => ({ state, rows: visible.filter((item) => item.state === state) }))
    .filter(({ state, rows }) => (filter === 'all' ? rows.length > 0 : filter === state))
  const keys: string[] = []
  const owner = new Map<string, string>()
  for (const { state, rows } of groups) {
    keys.push(headerKey(state))
    if (collapsed.has(state)) continue
    for (const row of rows) {
      keys.push(`r:${row.id}`)
      owner.set(`r:${row.id}`, headerKey(state))
    }
  }
  const nav = useInboxListKeys({
    keys,
    onToggleSection: (state) => onToggleSection(state as InboxState),
    isCollapsed: (state) => collapsed.has(state as InboxState),
    headerOf: (key) => owner.get(key) ?? null,
    onToggleSelected,
  })
  return (
    <div className="inbox-sections" onKeyDown={nav.onKeyDown} onFocus={nav.onFocus}>
      {groups.map(({ state, rows }) => {
        const isCollapsed = collapsed.has(state)
        const bodyId = `${uid}-section-${state}`
        const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))
        return (
          <section className="inbox-section" key={state} aria-labelledby={`${uid}-section-head-${state}`}>
            <header className="inbox-section__head">
              <input type="checkbox" className="inbox-check" tabIndex={-1}
                aria-label={`Select all in ${SECTION_LABEL[state]}`}
                checked={allSelected} disabled={rows.length === 0}
                onChange={(event) => onSelectSection(rows, event.target.checked)} />
              <button type="button" className="inbox-section__toggle" id={`${uid}-section-head-${state}`}
                data-row-key={headerKey(state)} tabIndex={nav.current === headerKey(state) ? 0 : -1}
                aria-expanded={!isCollapsed} aria-controls={bodyId} onClick={() => onToggleSection(state)}>
                <span className={`codicon codicon-chevron-${isCollapsed ? 'right' : 'down'}`} aria-hidden="true" />
                <span className="inbox-section__label">{SECTION_LABEL[state]}</span>
                <span className="inbox-count">{rows.length}</span>
              </button>
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
                        tabIndex={nav.current === `r:${item.id}` ? 0 : -1}
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
