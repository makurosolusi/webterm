// One tab of the strip: role=tab, roving tabindex, favicon/status icon, ellipsised title, agent marker, close button.
import type { MouseEvent, PointerEvent } from 'react'
import { Bot, X } from 'lucide-react'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import type { BrowserTab } from '../../shared/browser.tabs'
import { BrowserTabIcon } from './BrowserTabIcon'
import { tabAriaLabel, tabTitle, tabTooltip } from './browserTabs.labels'

/** DOM id of a tab, for `aria-labelledby` on the panel it controls. */
export const browserTabDomId = (tabId: string): string => `bt-tab-${tabId}`

export interface BrowserTabItemProps {
  tab: BrowserTab
  active: boolean
  isAgent: boolean
  /** Roving tabindex: only one tab is in the page tab order. */
  focusable: boolean
  /** Drop indicator drawn on this tab's left or right edge while another tab is dragged here. */
  drop?: 'before' | 'after'
  dragging: boolean
  panelId?: string
  onActivate: () => void
  onClose: () => void
  onFocus: () => void
  onContextMenu: (e: MouseEvent) => void
  onPointerDown: (e: PointerEvent) => void
}

export function BrowserTabItem(p: BrowserTabItemProps) {
  const { tab } = p
  const title = tabTitle(tab)
  return (
    <IconTooltip label={tabTooltip(tab)} side="bottom">
      <div
        role="tab"
        id={browserTabDomId(tab.tabId)}
        className="bt-tab"
        aria-selected={p.active}
        aria-controls={p.panelId}
        aria-label={tabAriaLabel(tab, p.isAgent)}
        tabIndex={p.focusable ? 0 : -1}
        data-tab-id={tab.tabId}
        data-active={p.active || undefined}
        data-agent={p.isAgent || undefined}
        data-state={tab.crashed ? 'crashed' : tab.discarded ? 'discarded' : tab.loading ? 'loading' : 'ready'}
        data-drop={p.drop}
        data-dragging={p.dragging || undefined}
        onClick={p.onActivate}
        onFocus={p.onFocus}
        onContextMenu={p.onContextMenu}
        onPointerDown={p.onPointerDown}
        // Middle button closes (Chrome); its mousedown would otherwise start browser autoscroll.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); p.onClose() } }}
      >
        <BrowserTabIcon tab={tab} />
        <span className="bt-title">{title}</span>
        {p.isAgent && <Bot className="bt-agent" data-agent-marker aria-hidden="true" />}
        <IconButton
          label={`Close ${title}`}
          size="icon-xs"
          className="bt-close"
          data-tab-close
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); p.onClose() }}
        >
          <X aria-hidden="true" />
        </IconButton>
      </div>
    </IconTooltip>
  )
}
