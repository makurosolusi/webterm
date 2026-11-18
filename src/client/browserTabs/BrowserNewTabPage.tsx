// New-tab page (Chrome's NTP, trimmed for a canvas node): a search "fakebox" that hands focus to the toolbar's ONE address
// field, the shortcut grid, and the recently closed tabs (the Ctrl+Shift+T history) only when there are any.
import { useEffect, useRef } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SEARCH_ENGINES, toSearchEngine } from '../../shared/browser.omnibox'
import type { BrowserTab } from '../../shared/browser.tabs'
import BrowserShortcuts from '../BrowserShortcuts'
import { omniboxOf } from '../browser.omniboxDom'
import { TOOLBAR_TEXT } from '../browser.uxText'
import { useLiveSettings } from '../useSettings'
import { hostOf, tabTitle } from './browserTabs.labels'

/** Rows of "Recently closed" shown on the page; the full history (MAX_CLOSED_HISTORY) stays reachable via Ctrl+Shift+T. */
const CLOSED_ROWS_MAX = 5

export interface BrowserNewTabPageProps {
  closed: BrowserTab[]
  /** Navigate this tab (a shortcut tile). Typed input goes through the toolbar, not this page. */
  onNavigate: (url: string) => void
  /** Reopen one entry of `closed` (a new tab id is stamped by the parent). */
  onReopen: (closedTabId: string) => void
  /** Why a reopen cannot run right now (tab limit); disables the rows with the reason shown. */
  reopenBlockedReason?: string
  /** Focus the address field when the page appears; false for agent-owned tabs so an agent never steals the human's focus. */
  autoFocus?: boolean
}

export function BrowserNewTabPage({ closed, onNavigate, onReopen, reopenBlockedReason, autoFocus = false }: BrowserNewTabPageProps) {
  const root = useRef<HTMLElement>(null)
  const engine = SEARCH_ENGINES[toSearchEngine(useLiveSettings().browserSearchEngine)].label
  useEffect(() => {
    const el = root.current
    if (!autoFocus || !el) return
    // Only when focus is free or already in this node: never pull it out of a terminal or another node.
    const active = document.activeElement
    if (active && active !== document.body && !el.closest('.browser-node')?.contains(active)) return
    omniboxOf(el)?.focus()
  }, [autoFocus])
  const rows = closed.slice(0, CLOSED_ROWS_MAX)
  return (
    <section ref={root} className="bt-newtab nodrag nowheel nopan nokey" aria-label="New tab">
      <h2 className="bt-sr">New tab</h2>
      <div className="bt-newtab-inner">
        <Button
          type="button" variant="outline" className="bt-fakebox"
          onClick={(e) => omniboxOf(e.currentTarget)?.focus()}
        >
          <Search className="bt-fakebox-icon" aria-hidden="true" />
          <span>{TOOLBAR_TEXT.urlPlaceholderEngine(engine)}</span>
        </Button>
        <BrowserShortcuts onGo={onNavigate} />
        {rows.length > 0 && (
          <section className="bt-closed" aria-label="Recently closed">
            <h3>Recently closed</h3>
            {reopenBlockedReason && <p role="status" className="bt-closed-note">{reopenBlockedReason}</p>}
            {rows.map((t) => (
              <Button key={t.tabId} variant="ghost" size="bui" className="bt-closed-row" disabled={!!reopenBlockedReason} onClick={() => onReopen(t.tabId)}>
                <span className="bt-closed-title">{tabTitle(t)}</span>
                <span className="bt-closed-host">{hostOf(t.url)}</span>
                <span className="bt-closed-action">Reopen</span>
              </Button>
            ))}
          </section>
        )}
      </div>
    </section>
  )
}
