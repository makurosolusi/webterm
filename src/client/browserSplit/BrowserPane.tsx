// One pane of a split browser node: header + the tab's own surface (frames, input, size) + its states (loading, crashed,
// sleeping, blank) + the drop preview while a tab is dragged over it. Focus = the pane the human last pressed in.
import type { CSSProperties, PointerEvent } from 'react'
import { resolveDevice } from '../../shared/browser.devices'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'
import type { BrowserSession } from '../browser.useSession'
import { BrowserInput } from '../browser.surface'
import { BrowserTabStateView } from '../browserTabs/BrowserTabStates'
import { isBlankTab, tabTitle } from '../browserTabs/browserTabs.labels'
import { BrowserNewTabPage } from '../browserTabs/BrowserNewTabPage'
import { useDeviceSession, deviceStyle } from '../browser.device'
import { BrowserPaneHeader } from './BrowserPaneHeader'
import { BrowserSyncMiss } from './BrowserSyncMiss'
import { usePaneSession } from './usePaneSession'
import { zoneBox, zoneLabel } from './browserSplit.drop'
import type { DragKind, DropZone } from './browserSplit.drop'
import type { SplitControls } from './useBrowserSplit'
import './browserSplit.css'

export interface BrowserPaneProps {
  tab: BrowserTab
  state: BrowserTabsState
  session: BrowserSession
  controls: SplitControls
  style: CSSProperties
  focused: boolean
  /** Zone being previewed while a tab or a pane is dragged over this pane, and which of the two it is. */
  dropZone?: DropZone
  dropKind?: DragKind
  /** This pane is the one being dragged (drawn lifted). */
  lifted?: boolean
  onGrip: (e: PointerEvent, tabId: string) => void
  wasDragged: () => boolean
}

export function BrowserPane({ tab, state, session, controls, style, focused, dropZone, dropKind = 'tab', lifted, onGrip, wasDragged }: BrowserPaneProps) {
  const device = resolveDevice(tab.device)
  const pane = usePaneSession(session, tab.tabId, !device)
  const surface = useDeviceSession(pane, device)
  const reload = () => controls.reload(tab.tabId)
  const wake = () => undefined // a pane on screen is woken by the server as soon as it is shown (view message)
  const blank = isBlankTab(tab) && !tab.crashed && !tab.discarded

  return (
    <div
      className={`bp${focused ? ' bp--focus' : ''}${lifted ? ' bp--lift' : ''}`}
      style={style}
      role="group"
      aria-label={`Pane: ${tabTitle(tab)}`}
      aria-current={focused ? 'true' : undefined}
      data-pane-tab={tab.tabId}
      onPointerDownCapture={() => controls.focus(tab.tabId)}
    >
      <BrowserPaneHeader
        tab={tab} tabs={state.tabs} shown={controls.shown} focused={focused} size={pane.size}
        onPick={(id) => { void controls.assign(tab.tabId, id) }}
        onDevice={(d) => { void controls.setDevice(tab.tabId, d) }}
        onClose={() => { void controls.closePane(tab.tabId) }}
        onGrip={(e) => onGrip(e, tab.tabId)}
        moves={{
          can: (dir) => controls.neighbour(tab.tabId, dir) !== null,
          run: (dir) => { void controls.moveDir(tab.tabId, dir) },
          swapWith: (id) => { void controls.movePane(tab.tabId, id, 'center') },
          wasDragged,
        }}
      />
      <div ref={pane.hostRef} className={`bp-body${device ? ' bp-body--device' : ''}`} style={deviceStyle(device)}>
        <BrowserInput session={surface} />
        {tab.loading && <div className="browser-loading" role="progressbar" aria-label="Loading" />}
        <BrowserSyncMiss sync={session.sync} tabId={tab.tabId} />
        {blank && (
          <div className="bt-overlay">
            <BrowserNewTabPage
              closed={[]} // reopening a closed tab belongs to the strip; a pane only navigates
              onNavigate={(url) => { void controls.navigateIn(tab.tabId, url) }}
              onReopen={() => undefined}
            />
          </div>
        )}
        {(tab.crashed || tab.discarded) && <div className="bt-overlay"><BrowserTabStateView tab={tab} onReload={reload} onWake={wake} /></div>}
        {dropZone && (
          <div className="bp-drop" aria-hidden="true" style={zoneBox(dropZone)} data-zone={dropZone} data-kind={dropKind}>
            <span className="bp-drop__label">{zoneLabel(dropZone, dropKind)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
