// The panes of a split browser node: a FLAT list keyed by tab id (like PaneView for terminals: splitting only changes
// `style`, so no pane's canvas is remounted), plus a separator per split and the swap-by-dragging-a-header gesture.
import { useRef } from 'react'
import { MIN_PANE_PX } from '../../shared/browser.layout'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import type { Pane } from '../../shared/workspace.shape'
import type { BrowserSession } from '../browser.useSession'
import { paneLayout } from '../paneTree'
import { BrowserPane } from './BrowserPane'
import { BrowserSeparator } from './BrowserSeparator'
import type { DropHint } from './browserSplit.drop'
import { usePaneDrag } from './usePaneDrag'
import { tabTitle } from '../browserTabs/browserTabs.labels'
import type { SplitControls } from './useBrowserSplit'

export interface BrowserPaneTreeProps {
  layout: Pane
  state: BrowserTabsState
  session: BrowserSession
  controls: SplitControls
  /** Where a dragged tab would land, shown as a preview inside that pane. */
  dropHint: DropHint | null
}

const pct = (n: number) => `${n}%`
const SMALL_NODE_NOTICE = 'Enlarge the node to see every pane'

export function BrowserPaneTree({ layout, state, session, controls, dropHint }: BrowserPaneTreeProps) {
  const { panes, dividers } = paneLayout(layout)
  const hostRef = useRef<HTMLDivElement>(null)
  const tooSmall = controls.stage.w > 0 && panes.some((p) => (controls.stage.w * p.width) / 100 < MIN_PANE_PX || (controls.stage.h * p.height) / 100 < MIN_PANE_PX)

  const drag = usePaneDrag({
    allowed: controls.canMovePane,
    onDrop: (tabId, target, zone) => { void controls.movePane(tabId, target, zone) },
  })
  const dragged = drag.view
  const hint = dragged ? dragged.hit : dropHint
  const dragTab = dragged ? state.tabs.find((t) => t.tabId === dragged.tabId) : undefined

  return (
    <div ref={hostRef} className="bp-tree" role="group" aria-label="Browser panes">
      {panes.map((p) => {
        const tab = state.tabs.find((t) => t.tabId === p.id)
        if (!tab) return null
        return (
          <BrowserPane
            key={p.id} tab={tab} state={state} session={session} controls={controls}
            style={{ left: pct(p.left), top: pct(p.top), width: pct(p.width), height: pct(p.height) }}
            focused={p.id === state.activeTabId}
            dropZone={hint?.paneTabId === p.id ? hint.zone : undefined}
            dropKind={dragged?.hit ? 'pane' : 'tab'}
            lifted={dragged?.tabId === p.id}
            onGrip={drag.begin}
            wasDragged={drag.wasDragged}
          />
        )
      })}
      {dividers.map((d) => {
        const first = d.dir === 'h' ? d.at - d.box.left : d.at - d.box.top
        const span = d.dir === 'h' ? d.box.width : d.box.height
        return (
          <BrowserSeparator
            key={d.path || 'root'} divider={d} ratio={span > 0 ? first / span : 0.5}
            host={() => hostRef.current}
            onRatio={controls.resize} onCommit={() => { void controls.commitResize() }} onReset={(path) => { void controls.resetRatio(path) }}
          />
        )
      })}
      {dragged && dragTab && <div className="bp-ghost" aria-hidden="true" style={{ left: dragged.x + 12, top: dragged.y + 12 }}>{tabTitle(dragTab)}</div>}
      <div className="bt-sr" role="status" aria-live="polite" data-testid="pane-announce">{controls.announcement}</div>
      {tooSmall && <div className="bp-small" role="status">{SMALL_NODE_NOTICE}</div>}
    </div>
  )
}
