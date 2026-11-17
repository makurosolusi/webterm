// Left side bar, VS Code style: one column showing exactly ONE view (Layers, Sessions, Agent
// History), chosen on the activity bar. Only the shown view is mounted; Sessions and History
// rebuild cheaply from props/fetch. One width (`--ss-w`) for every view, resized from the right edge.
import { useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { PanelSash } from '../bottomPanelSash'
import { sessionsPanelWidth } from '../sessionsPanel.width'
import type { SideBarView } from './sideBar.view'
import { SideBarTitleSlot } from './sideBarTitleActions'
import '../sessions-panel.css'
import './sideBar.css'

export const SIDE_BAR_VIEW_TITLE: Record<SideBarView, string> = {
  layers: 'Layers',
  sessions: 'Sessions',
  history: 'Agent History',
  skills: 'Skills',
}

export interface SideBarProps {
  /** Closed = nothing rendered; the only way back is the activity bar (or ⌘⇧\). */
  open: boolean
  view: SideBarView
  onClose: () => void
  /** Badge next to the LAYERS title (node count of the open board). */
  layerCount?: number
  layers: ReactNode
  sessions: ReactNode
  history: ReactNode
  skills: ReactNode
}

export default function SideBar({ open, view, onClose, layerCount, ...slots }: SideBarProps) {
  // Title toolbar slot the shown view portals its own actions into (`SideBarTitleActions`).
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  if (!open) return null
  return (
    <div className="sessions-sidebar nodrag" role="complementary" aria-label="Side Bar" data-view={view}>
      <div className="sessions-sidebar__head">
        <h2 className="sessions-sidebar__title side-bar__title">{SIDE_BAR_VIEW_TITLE[view]}</h2>
        {view === 'layers' && layerCount !== undefined && <span className="sessions-sidebar__count">{layerCount}</span>}
        <div ref={setTitleSlot} className="sessions-sidebar__actions" />
        <IconButton label="Hide Side Bar" commandId="view.sessions" className="ss-action ss-action--hide" onClick={onClose}>
          <span className="codicon codicon-layout-sidebar-left-off" aria-hidden />
        </IconButton>
      </div>
      <SideBarTitleSlot.Provider value={titleSlot}>
        <div className="side-bar__view" data-slot={`side-bar-${view}`}>{slots[view]}</div>
      </SideBarTitleSlot.Provider>
      <PanelSash size={sessionsPanelWidth} orientation="vertical" trailing label="Resize Side Bar" className="sessions-sidebar__sash" />
    </div>
  )
}
