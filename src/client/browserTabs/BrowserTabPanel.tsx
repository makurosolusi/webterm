// What covers the page of the active tab: the new-tab page (a blank tab beside others, or after closing one) or the
// crashed/discarded state. Navigation errors keep the node's existing overlay (BrowserNoticeAction); a normal tab shows
// nothing here and the streamed frame is visible.
import { canAddTab, type BrowserTab, type BrowserTabAction, type BrowserTabsState } from '../../shared/browser.tabs'
import { BrowserNewTabPage } from './BrowserNewTabPage'
import { BrowserTabStateView } from './BrowserTabStates'
import { isBlankTab } from './browserTabs.labels'
import './browserTabs.css'

/** The first blank tab keeps the node's start page; the new-tab page is for blank tabs once there is tab history or company. */
export function showsNewTabPage(view: BrowserTabsState, active: BrowserTab | undefined, standIn: boolean): boolean {
  if (standIn) return false
  if (!active) return true
  return isBlankTab(active) && (view.tabs.length > 1 || view.closed.length > 0)
}

export interface BrowserTabPanelProps {
  view: BrowserTabsState
  active?: BrowserTab
  standIn: boolean
  act: (a: BrowserTabAction) => void
  /** Navigate the active tab (the node's `go`). */
  go: (url: string) => void
}

export function BrowserTabPanel({ view, active, standIn, act, go }: BrowserTabPanelProps) {
  if (showsNewTabPage(view, active, standIn)) {
    const full = canAddTab(view)
    return (
      <div className="bt-overlay">
        <BrowserNewTabPage
          closed={view.closed} onNavigate={active ? go : (url) => act({ type: 'new', newTabId: '', url })}
          onReopen={(fromTabId) => act({ type: 'reopenClosed', newTabId: '', fromTabId })}
          reopenBlockedReason={full.ok ? undefined : full.reason}
        />
      </div>
    )
  }
  if (!active || standIn || !(active.crashed || active.discarded)) return null
  const reload = () => act({ type: 'reload', tabId: active.tabId })
  return <div className="bt-overlay"><BrowserTabStateView tab={active} onReload={reload} onWake={reload} /></div>
}
