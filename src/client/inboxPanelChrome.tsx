// Presentational chrome for `InboxPanel`: header, section filter chips, bulk toolbar, error
// banner, and the empty/loading status line. Split out of `InboxPanel` to keep the container
// inside the repo's file-size budget. No state, fetching, or derived logic lives here; every
// label, aria-label, and class name is the panel's contract with `InboxPanel.test.tsx`.
import { AlertTriangle, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { InboxState } from './inboxApi'
import { SECTION_LABEL, SECTION_ORDER } from './inboxPanelModel'

/** Filter identity shared by the chip row and the section list. */
export type InboxFilter = 'all' | InboxState

export interface InboxPanelHeaderProps {
  uid: string
  total: number
  loading: boolean
  onRefresh: () => void
  onClose?: (() => void) | undefined
}

export function InboxPanelHeader(props: InboxPanelHeaderProps): React.JSX.Element {
  const { uid, total, loading, onRefresh, onClose } = props
  return (
    <header className="inbox-head">
      <ShieldAlert size={15} aria-hidden="true" />
      <h2 className="inbox-title" id={`${uid}-title`}>Inbox</h2>
      <span className="inbox-total" aria-label={`${total} items`}>{total}</span>
      <span className="inbox-grow" />
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh inbox" title="Refresh inbox"
        disabled={loading} onClick={onRefresh}>
        <RefreshCw size={14} aria-hidden="true" />
      </Button>
      {onClose && (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close inbox" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </Button>
      )}
    </header>
  )
}

export interface InboxPanelFiltersProps {
  filter: InboxFilter
  counts: Record<InboxFilter, number>
  onFilter: (key: InboxFilter) => void
}

export function InboxPanelFilters(props: InboxPanelFiltersProps): React.JSX.Element {
  const { filter, counts, onFilter } = props
  return (
    <div className="inbox-filters" role="group" aria-label="Filter inbox">
      <Tabs value={filter} onValueChange={(value) => onFilter(value as InboxFilter)}>
        <TabsList>
          {(['all', ...SECTION_ORDER] as const).map((key) => (
            <TabsTrigger key={key} value={key} onClick={() => onFilter(key)}>
              {key === 'all' ? 'All' : SECTION_LABEL[key]}
              <span className="inbox-count">{counts[key]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
      <Button type="button" variant="ghost" onClick={onReviewSelected}>
        Review selected
      </Button>
      <Button type="button" variant="ghost" onClick={onClear}>
        Clear
      </Button>
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
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{message}</span>
      <Button type="button" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export interface InboxPanelStatusProps {
  loading: boolean
  total: number
  hasError: boolean
}

/** Empty/loading status; an error banner owns the message while one is shown. */
export function InboxPanelStatus(props: InboxPanelStatusProps): React.JSX.Element | null {
  const { loading, total, hasError } = props
  if (hasError || total > 0) return null
  if (loading) return <p className="inbox-status" role="status">Loading inbox…</p>
  return <p className="inbox-status" role="status">Inbox is clear.</p>
}

export interface InboxPanelChromeProps {
  uid: string
  total: number
  loading: boolean
  filter: InboxFilter
  counts: Record<InboxFilter, number>
  listError: string | null
  selectedCount: number
  onRefresh: () => void
  onClose?: (() => void) | undefined
  onFilter: (key: InboxFilter) => void
  onReviewSelected: () => void
  onClearSelection: () => void
}

/**
 * Everything above the section list: header, filter chips, bulk toolbar, error banner, and the
 * empty/loading line, in that fixed order. The container supplies values; ordering lives here.
 */
export function InboxPanelChrome(props: InboxPanelChromeProps): React.JSX.Element {
  const { uid, total, loading, filter, counts, listError, selectedCount } = props
  return (
    <>
      <InboxPanelHeader uid={uid} total={total} loading={loading} onClose={props.onClose}
        onRefresh={props.onRefresh} />
      <InboxPanelFilters filter={filter} counts={counts} onFilter={props.onFilter} />
      {selectedCount > 0 && (
        <InboxPanelBulk selectedCount={selectedCount} onReviewSelected={props.onReviewSelected}
          onClear={props.onClearSelection} />
      )}
      {listError && <InboxPanelError message={listError} onRetry={props.onRefresh} />}
      <InboxPanelStatus loading={loading} total={total} hasError={listError !== null} />
    </>
  )
}
