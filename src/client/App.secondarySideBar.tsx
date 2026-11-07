// The secondary side bar (VS Code's auxiliary bar, where Copilot Chat lives): Central chat and the
// Central control panel as tabs of one right-hand surface. Docked, it takes a grid column so the
// canvas shrinks beside it (styles.css); maximized or below SIDE_BAR_OVERLAY_BREAKPOINT it
// overlays the canvas area instead. Views stay mounted while the side bar is open (hidden when
// inactive) so switching tabs never drops a stream or a draft.
import { lazy, Suspense, useState } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { InboxPanelSurface } from './inboxPanelSurface'
import { setSideBar, toggleSideBar, useNarrowWindow, useSideBar, type SideBarView } from './secondarySideBar.store'
import { LazyPaneFallback } from './lazyPaneFallback'
import './secondarySideBar.css'

// The views load when the side bar first opens; its chrome (tabs, actions) stays in the start-up chunk.
const ChatPanel = lazy(() => import('./ChatPanel'))
const CentralControlPanel = lazy(() => import('./central/CentralControlPanel'))

const VIEWS: { id: SideBarView; label: string; tooltip: string }[] = [
  { id: 'chat', label: 'Chat', tooltip: 'Central agent chat' },
  { id: 'central', label: 'Central', tooltip: 'Central control panel' },
]

/** The view the side bar shows: Central falls back to Chat while its flag is off. */
export function shownSideBarView(view: SideBarView, centralEnabled: boolean): SideBarView {
  return view === 'central' && !centralEnabled ? 'chat' : view
}

export default function SecondarySideBar({ centralEnabled }: { centralEnabled: boolean }): React.JSX.Element | null {
  const { open, view } = useSideBar()
  const narrow = useNarrowWindow()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  if (!open) return null
  const shown = shownSideBarView(view, centralEnabled)
  const views = VIEWS.filter((v) => v.id === 'chat' || centralEnabled)
  return (
    <InboxPanelSurface
      dock="right"
      className={narrow ? 'vscode-secondary-side-bar--overlay' : undefined}
      ariaLabel="Secondary Side Bar"
      tabs={views.map((v) => ({ ...v, closable: false }))}
      activeId={shown}
      onActivate={(id) => setSideBar({ view: id as SideBarView })}
      onClosePanel={() => setSideBar({ open: false })}
      actionsSlotRef={setSlot}
    >
      <div className="vscode-bottom-panel__pane" hidden={shown !== 'chat'}>
        <Suspense fallback={<LazyPaneFallback />}>
          <ChatPanel open embedded compact centralEnabled={centralEnabled} actionsHost={shown === 'chat' ? slot : null} />
        </Suspense>
      </div>
      {centralEnabled && (
        <div className="vscode-bottom-panel__pane" hidden={shown !== 'central'}>
          <Suspense fallback={<LazyPaneFallback />}>
            <CentralControlPanel open enabled actionsHost={shown === 'central' ? slot : null} />
          </Suspense>
        </div>
      )}
    </InboxPanelSurface>
  )
}

/** Title-bar layout control (VS Code's "Toggle Secondary Side Bar", top right). */
export function SecondarySideBarToggle(): React.JSX.Element {
  const { open } = useSideBar()
  return (
    <IconTooltip label="Toggle Secondary Side Bar" commandId="view.secondarySideBar">
      <button type="button" className="titlebar__action" aria-label="Toggle Secondary Side Bar"
        aria-pressed={open} onClick={toggleSideBar}>
        <span className={`codicon codicon-layout-sidebar-right${open ? '' : '-off'}`} aria-hidden />
      </button>
    </IconTooltip>
  )
}
