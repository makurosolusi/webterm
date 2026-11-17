// App's wiring of the left side bar: open state (`useSessionsOpen`), shown view, the activity
// click shared by the Dock icons and the "View: Show …" commands, and the Sessions icon badge.
import { useCallback, useMemo } from 'react'
import { useSessionsOpen } from '../SessionsPanel.open'
import { buildSessionList, otherWorkspaceGroups, signalCounts } from '../sessionList'
import type { AgentStatus, Workspace, WsNode } from '../../shared/workspace'
import { useSideBarViewCommands } from './sideBar.commands'
import { useOpenSideBarRequests } from './sideBar.open'
import { activityClick, useSideBarView, type SideBarView } from './sideBar.view'

/** Sessions in OTHER workspaces waiting for the user (the open board's are on the canvas already). */
export function sessionsAttentionCount(
  workspaces: Workspace[], liveNodes: WsNode[] | null, activeId: string | null, statuses: Record<string, AgentStatus>,
): number {
  const rows = otherWorkspaceGroups(buildSessionList(workspaces, liveNodes, activeId, statuses, '')).flatMap((g) => g.sessions)
  return signalCounts(rows).attention
}

export function useAppSideBar() {
  const [open, setOpen] = useSessionsOpen()
  const [view, setView] = useSideBarView()
  const select = useCallback((clicked: SideBarView) => {
    const next = activityClick({ open, view }, clicked)
    setOpen(next.open)
    setView(next.view)
  }, [open, view, setOpen, setView])
  useSideBarViewCommands(select)
  const show = useCallback((v: SideBarView) => { setOpen(true); setView(v) }, [setOpen, setView])
  useOpenSideBarRequests(show)
  return { open, setOpen, view, select }
}

export type AppSideBar = ReturnType<typeof useAppSideBar>

export function useSessionsAttention(
  workspaces: Workspace[], liveNodes: WsNode[] | null, activeId: string | null, statuses: Record<string, AgentStatus>,
): number {
  return useMemo(() => sessionsAttentionCount(workspaces, liveNodes, activeId, statuses), [workspaces, liveNodes, activeId, statuses])
}
