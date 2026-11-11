// App's side of the URL contract (`./appRoute`): the overlay state App used to hold in `useState`
// (Settings, Help, Kanban) now read from and written to the URL, plus the two-way sync between the
// board on screen and `/w/:workspaceId`.
import { useEffect, useMemo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAppRoute, type AppRoute, type AppRouteActions } from './appRoute'
import type { Workspace } from '../shared/workspace'

/** URL-derived overlay state with the setter shapes App's children already take. */
export interface AppUrlState {
  route: AppRoute
  actions: AppRouteActions
  board: boolean
  setBoard: Dispatch<SetStateAction<boolean>>
  showSettings: boolean
  setShowSettings: (open: boolean) => void
  showHelp: boolean
  setShowHelp: (open: boolean) => void
}

/** Overlays from the URL; setters are stable across renders. */
export function useAppUrlState(): AppUrlState {
  const { route, actions } = useAppRoute()
  const routeRef = useRef(route)
  routeRef.current = route
  const setters = useMemo(() => ({
    // `routeRef`, not the render's `route`: a toggle must flip what the URL says NOW.
    setBoard: (v: SetStateAction<boolean>) => {
      const open = typeof v === 'function' ? v(routeRef.current.view === 'kanban') : v
      actions.setView(open ? 'kanban' : null)
    },
    setShowSettings: (open: boolean) => (open ? actions.openSettings(routeRef.current.settings ?? undefined) : actions.closeSettings()),
    setShowHelp: actions.setHelp,
  }), [actions])
  return { route, actions, board: route.view === 'kanban', showSettings: route.settings !== null, showHelp: route.help, ...setters }
}

export interface WorkspaceUrlSyncDeps {
  urlWorkspaceId: string | null
  activeId: string | null
  hydrated: boolean
  workspaces: readonly Workspace[]
  onSelect: (id: string) => Promise<void>
  goWorkspace: AppRouteActions['goWorkspace']
}

/**
 * Board on screen ↔ URL. Each effect reacts to ONE side only, so they never fight: a new board on
 * screen (click, create, delete, Central's push) writes `/w/:id` (replace on the first board after
 * boot, so `/` and an unknown id are corrected without a Back step); a URL change (Back/Forward,
 * a pasted link) switches board, and an id that is not a workspace is replaced by the shown one.
 */
export function useWorkspaceUrlSync(deps: WorkspaceUrlSyncDeps): void {
  const latest = useRef(deps)
  latest.current = deps
  const shown = useRef<string | null>(null)
  const { activeId, hydrated, urlWorkspaceId } = deps

  useEffect(() => {
    if (!hydrated) return
    const first = shown.current === null
    shown.current = activeId
    if (activeId !== latest.current.urlWorkspaceId) latest.current.goWorkspace(activeId, { replace: first })
  }, [activeId, hydrated])

  useEffect(() => {
    const { activeId: onScreen, workspaces, onSelect, goWorkspace } = latest.current
    if (!hydrated || urlWorkspaceId === null || urlWorkspaceId === onScreen) return
    if (workspaces.some((w) => w.id === urlWorkspaceId)) void onSelect(urlWorkspaceId)
    else goWorkspace(onScreen, { replace: true })
  }, [urlWorkspaceId, hydrated])
}
