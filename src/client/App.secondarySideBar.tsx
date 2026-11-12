// The secondary side bar (VS Code's auxiliary bar, where Copilot Chat lives): Central chat and the
// Central control panel (tab "Control") as tabs of one right-hand surface. Docked, it takes a grid column so the
// canvas shrinks beside it (styles.css); maximized or below SIDE_BAR_OVERLAY_BREAKPOINT it
// overlays the canvas area instead. Views stay mounted while the side bar is open (hidden when
// inactive) so switching tabs never drops a stream or a draft.
import { lazy, Suspense, useState } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { InboxPanelSurface } from './inboxPanelSurface'
import { setSideBar, toggleSideBar, useNarrowWindow, useSideBar, type SideBarView } from './secondarySideBar.store'
import { LazyPaneFallback } from './lazyPaneFallback'
import { CapabilityOffer } from './CapabilityOffer'
import { useCentralTabUrlSync } from './secondarySideBar.route'
import type { AppRouteActions, CentralRouteTab } from './appRoute'
import './secondarySideBar.css'

// The views load when the side bar first opens; its chrome (tabs, actions) stays in the start-up chunk.
const ChatPanel = lazy(() => import('./ChatPanel'))
const CentralControlPanel = lazy(() => import('./central/CentralControlPanel'))

const VIEWS: { id: SideBarView; label: string; tooltip: string }[] = [
  { id: 'chat', label: 'Chat', tooltip: 'Central agent chat' },
  // Id stays `central`: it is the persisted view (`webterm.secondarySideBar`); only the label says Control.
  { id: 'central', label: 'Control', tooltip: 'Memory, automations and spending; with Central on also its status, abilities, agents and skills' },
]

export interface SecondarySideBarProps {
  centralEnabled: boolean
  /** The URL's `?ctab=` and its setter (App); without them the Central tab is local state. */
  ctab?: CentralRouteTab | null
  setCentralTab?: AppRouteActions['setCentralTab']
}

const NO_URL: AppRouteActions['setCentralTab'] = () => {}

export default function SecondarySideBar({ centralEnabled, ctab = null, setCentralTab }: SecondarySideBarProps): React.JSX.Element | null {
  useCentralTabUrlSync(ctab, setCentralTab ?? NO_URL, setCentralTab !== undefined, centralEnabled ? 'status' : 'memory')
  const { open, view } = useSideBar()
  const narrow = useNarrowWindow()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  if (!open) return null
  // Control is always there: memory, automations and spending work without Central (CENTRAL_FREE_TABS).
  const shown = view
  const views = VIEWS
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
        {/* Central not ready: the "turn on / Set up Claude Code" offer the Dock's old shield icon held. Once on,
            the shared capabilities cache flips `centralEnabled`, so this goes and the Control tab appears. */}
        {!centralEnabled && <div className="chat-setup" data-slot="central-setup"><CapabilityOffer id="central" /></div>}
        <Suspense fallback={<LazyPaneFallback />}>
          <ChatPanel open embedded compact centralEnabled={centralEnabled} actionsHost={shown === 'chat' ? slot : null} />
        </Suspense>
      </div>
      {shown === 'central' || centralEnabled ? (
        <div className="vscode-bottom-panel__pane" hidden={shown !== 'central'}>
          <Suspense fallback={<LazyPaneFallback />}>
            <CentralControlPanel open enabled={centralEnabled} actionsHost={shown === 'central' ? slot : null}
              {...(setCentralTab ? { tab: ctab ?? undefined, onTabChange: setCentralTab } : {})} />
          </Suspense>
        </div>
      ) : null}
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
