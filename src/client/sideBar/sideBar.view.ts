// Which view the left side bar shows (VS Code's view containers): exactly one at a time, chosen
// on the activity bar. Open/closed stays in `useSessionsOpen` (key `webterm.sessionsPinned`).
import { useEffect, useState } from 'react'

export type SideBarView = 'layers' | 'sessions' | 'history' | 'skills'
export const SIDE_BAR_VIEWS: readonly SideBarView[] = ['layers', 'sessions', 'history', 'skills']
export const SIDE_BAR_VIEW_KEY = 'webterm.sideBarView'
export const DEFAULT_SIDE_BAR_VIEW: SideBarView = 'layers'

export interface SideBarState {
  open: boolean
  view: SideBarView
}

/** Stored text → view; anything unknown (older build, hand edit) falls back to Layers. */
export function parseSideBarView(raw: string | null): SideBarView {
  return SIDE_BAR_VIEWS.find((v) => v === raw) ?? DEFAULT_SIDE_BAR_VIEW
}

/** VS Code activity click: the shown view's icon hides the side bar; any other icon shows its view. */
export function activityClick(state: SideBarState, clicked: SideBarView): SideBarState {
  if (state.open && state.view === clicked) return { open: false, view: state.view }
  return { open: true, view: clicked }
}

function readView(): SideBarView {
  // Private mode / blocked site data makes localStorage itself throw; the side bar still works.
  try {
    return parseSideBarView(localStorage.getItem(SIDE_BAR_VIEW_KEY))
  } catch {
    return DEFAULT_SIDE_BAR_VIEW
  }
}

/** The shown view, persisted across reloads. */
export function useSideBarView() {
  const [view, setView] = useState(readView)
  useEffect(() => {
    try {
      localStorage.setItem(SIDE_BAR_VIEW_KEY, view)
    } catch {
      // Storage refused (private mode): the choice lasts for this tab only.
    }
  }, [view])
  return [view, setView] as const
}
