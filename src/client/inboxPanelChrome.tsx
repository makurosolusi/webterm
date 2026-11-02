// Presentational chrome for `InboxPanel`: toolbar action, filter row, bulk toolbar, error
// banner, and the empty/loading status line. Split out of `InboxPanel` to keep the container
// inside the repo's file-size budget. No state, fetching, or derived logic lives here; every
// label, aria-label, and class name is the panel's contract with `InboxPanel.test.tsx`.
import type { InboxState } from './inboxApi'
import { SECTION_LABEL, SECTION_ORDER } from './inboxPanelModel'

/** Filter identity shared by the toggle row and the section list. */
export type InboxFilter = 'all' | InboxState

export interface InboxPanelActionsProps {
  loading: boolean
  onRefresh: () => void
}

/** Toolbar controls: refresh. The item count lives in the tab badge; close is the panel's. */
export function InboxPanelActions(props: InboxPanelActionsProps): React.JSX.Element {
  const { loading, onRefresh } = props
  return (
    <button type="button" className="vscode-panel-action" aria-label="Refresh inbox" title="Refresh inbox"
      disabled={loading} onClick={onRefresh}>
      <span className="codicon codicon-refresh" aria-hidden="true" />
    </button>
  )
}

export interface InboxPanelFiltersProps {
  filter: InboxFilter
  counts: Record<InboxFilter, number>
  query: string
  onFilter: (key: InboxFilter) => void
  onQuery: (query: string) => void
}

/** Problems-view filter row: a 24px text box plus state toggles with counts. */
export function InboxPanelFilters(props: InboxPanelFiltersProps): React.JSX.Element {
  const { filter, counts, query, onFilter, onQuery } = props
  return (
    <div className="inbox-filters" role="group" aria-label="Filter inbox">
      <input type="search" className="inbox-filter-input" aria-label="Filter items"
        placeholder="Filter (e.g. text, project)" value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); onQuery('') } }} />
      <div className="inbox-filter-toggles" role="tablist" aria-label="Filter by state">
        {(['all', ...SECTION_ORDER] as const).map((key) => (
          <button key={key} type="button" role="tab" className="inbox-filter-toggle"
            aria-selected={filter === key} data-active={filter === key ? 'true' : 'false'}
            onClick={() => onFilter(key)}>
            {key === 'all' ? 'All' : SECTION_LABEL[key]}
            <span className="inbox-count">{counts[key]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export interface InboxPanelBulkProps {
  selectedCount: number
  onReviewSelected: () => void
  onClear: () => void
}

export function InboxPanelBulk(props: InboxPanelBulkProps): React.JSX.Element {
  const { selectedCount, onReviewSelected, onClear } = props
  return (
    <div className="inbox-bulk" role="toolbar" aria-label="Group actions">
      <span aria-live="polite">{selectedCount} selected</span>
      <button type="button" className="inbox-action" onClick={onReviewSelected}>Review selected</button>
      <button type="button" className="inbox-action inbox-action--secondary" onClick={onClear}>Clear</button>
    </div>
  )
}

export interface InboxPanelErrorProps {
  message: string
  onRetry: () => void
}

export function InboxPanelError(props: InboxPanelErrorProps): React.JSX.Element {
  const { message, onRetry } = props
  return (
    <div className="inbox-error" role="alert">
      <span className="codicon codicon-error" aria-hidden="true" />
      <span className="inbox-error__text">{message}</span>
      <button type="button" className="inbox-action inbox-action--secondary" onClick={onRetry}>Retry</button>
    </div>
  )
}

export interface InboxPanelStatusProps {
  loading: boolean
  total: number
  /** Rows left after the state toggle and the text filter. */
  matches: number
  hasError: boolean
}

/** Welcome-view style empty/loading state; an error banner owns the message while one is shown. */
export function InboxPanelStatus(props: InboxPanelStatusProps): React.JSX.Element | null {
  const { loading, total, matches, hasError } = props
  if (hasError) return null
  if (total === 0) {
    if (loading) return <p className="inbox-status" role="status">Loading inbox…</p>
    return (
      <div className="inbox-status inbox-welcome" role="status">
        <p className="inbox-welcome__title">Inbox is clear.</p>
        <p className="inbox-welcome__hint">Approvals and items that need you will appear here.</p>
      </div>
    )
  }
  if (matches === 0) {
    return <p className="inbox-status" role="status">No results found with provided filter criteria.</p>
  }
  return null
}

export interface InboxPanelChromeProps {
  total: number
  loading: boolean
  filter: InboxFilter
  counts: Record<InboxFilter, number>
  query: string
  matches: number
  listError: string | null
  selectedCount: number
  onRefresh: () => void
  onFilter: (key: InboxFilter) => void
  onQuery: (query: string) => void
  onReviewSelected: () => void
  onClearSelection: () => void
}

/**
 * Everything between the title bar and the section list: filter row, bulk toolbar, error
 * banner, and the empty/loading state, in that fixed order. The container supplies values;
 * ordering lives here.
 */
export function InboxPanelChrome(props: InboxPanelChromeProps): React.JSX.Element {
  const { total, loading, filter, counts, query, matches, listError, selectedCount } = props
  return (
    <>
      <InboxPanelFilters filter={filter} counts={counts} query={query} onFilter={props.onFilter}
        onQuery={props.onQuery} />
      {selectedCount > 0 && (
        <InboxPanelBulk selectedCount={selectedCount} onReviewSelected={props.onReviewSelected}
          onClear={props.onClearSelection} />
      )}
      {listError && <InboxPanelError message={listError} onRetry={props.onRefresh} />}
      <InboxPanelStatus loading={loading} total={total} matches={matches} hasError={listError !== null} />
    </>
  )
}
