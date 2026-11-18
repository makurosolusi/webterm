// The panes of a split browser node: a FLAT list keyed by tab id (like PaneView for terminals: splitting only changes
// `style`, so no pane's canvas is remounted), plus a separator per split and the swap-by-dragging-a-header gesture.
import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { MIN_PANE_PX } from '../../shared/browser.layout'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import type { Pane } from '../../shared/workspace.shape'
import type { BrowserSession } from '../browser.useSession'
import { paneLayout } from '../paneTree'
import { BrowserPane } from './BrowserPane'
import { BrowserSeparator } from './BrowserSeparator'
import type { DropHint } from './browserSplit.drop'
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
const GRIP_THRESHOLD_PX = 4
const SMALL_NODE_NOTICE = 'Enlarge the node to see every pane'

export function BrowserPaneTree({ layout, state, session, controls, dropHint }: BrowserPaneTreeProps) {
  const { panes, dividers } = paneLayout(layout)
  const hostRef = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<string | null>(null)
  const tooSmall = controls.stage.w > 0 && panes.some((p) => (controls.stage.w * p.width) / 100 < MIN_PANE_PX || (controls.stage.h * p.height) / 100 < MIN_PANE_PX)

  /** Drag a pane header onto another pane to swap them; a press that does not move stays a click. */
  const grip = (e: PointerEvent, tabId: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const x0 = e.clientX, y0 = e.clientY
    let target: string | null = null
    let moved = false
    const move = (ev: globalThis.PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < GRIP_THRESHOLD_PX) return
      moved = true
      const hit = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-pane-tab]')?.dataset.paneTab ?? null
      target = hit && hit !== tabId ? hit : null
      setOver(target)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setOver(null)
      if (moved && target) void controls.swap(tabId, target)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

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
            dropZone={dropHint?.paneTabId === p.id ? dropHint.zone : undefined}
            swapTarget={over === p.id}
            onGrip={grip}
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
      {tooSmall && <div className="bp-small" role="status">{SMALL_NODE_NOTICE}</div>}
    </div>
  )
}
