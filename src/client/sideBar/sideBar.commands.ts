// "View: Show Layers / Sessions / Agent History": one palette command per side bar view, no
// default keys (rebindable), each doing exactly what its activity bar icon does.
import { useMemo, useRef } from 'react'
import { useRegisterCommands, type Command } from '../commandRegistry'
import type { SideBarView } from './sideBar.view'

export const SIDE_BAR_VIEW_COMMANDS: Record<SideBarView, { id: string; label: string }> = {
  layers: { id: 'view.layers', label: 'View: Show Layers' },
  sessions: { id: 'view.sessionsList', label: 'View: Show Sessions' },
  history: { id: 'view.agentHistory', label: 'View: Show Agent History' },
  skills: { id: 'view.skills', label: 'View: Show Skills' },
}

/** The three commands for `select` (pure; tests read it without React). */
export function sideBarViewCommands(select: (view: SideBarView) => void): Command[] {
  return (Object.keys(SIDE_BAR_VIEW_COMMANDS) as SideBarView[]).map((view) => ({ ...SIDE_BAR_VIEW_COMMANDS[view], run: () => select(view) }))
}

/** Registers them while mounted; the handler goes through a ref so a fresh closure never re-registers. */
export function useSideBarViewCommands(select: (view: SideBarView) => void): void {
  const ref = useRef(select)
  ref.current = select
  const list = useMemo(() => sideBarViewCommands((view) => ref.current(view)), [])
  useRegisterCommands(list)
}
