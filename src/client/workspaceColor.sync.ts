// Workspace color on the client: the optimistic change (picker), its rollback, and following a color
// another window or Central changed (`t:'workspaceColor'`). A color is never part of a board save (the
// server stores it through its own route), so none of this touches `scheduleSave`.
import { useCallback, useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Workspace } from '../shared/workspace'
import { setWorkspaceColor, type ColorChange } from './api'
import { subscribeWorkspaceColor } from './ws'
import { showNotice } from './workspaceSave.notice'
import { describeWorkspaceColor } from '../shared/workspaceColor'
import type { WorkspaceColorMsg } from '../shared/protocol'
import { reportActionError } from './workspaceActionError'

export const COLOR_NOTICE_KEY = 'webterm-workspace-color'

export interface ColorTarget {
  activeWsRef: RefObject<Workspace | null>
  setActiveWs: Dispatch<SetStateAction<Workspace | null>>
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
}

/** `ws` with its color replaced; the same object when nothing differs (no re-render). */
export function withColor(ws: Workspace, color: string, colorShade: string): Workspace {
  return ws.color === color && ws.colorShade === colorShade ? ws : { ...ws, color, colorShade }
}

/** Put `color`/`colorShade` on board `id` in the list, the mounted board and its save-payload ref. */
export function applyColor(t: ColorTarget, id: string, color: string, colorShade: string): void {
  t.setWorkspaces((prev) => prev.map((w) => (w.id === id ? withColor(w, color, colorShade) : w)))
  t.setActiveWs((ws) => (ws && ws.id === id ? withColor(ws, color, colorShade) : ws))
  const cur = t.activeWsRef.current
  if (cur?.id === id) t.activeWsRef.current = withColor(cur, color, colorShade)
}

/** Follow color changes pushed by the server for as long as the caller is mounted. */
export function useWorkspaceColorPush(t: ColorTarget): void {
  const { activeWsRef, setActiveWs, setWorkspaces } = t
  useEffect(
    () => subscribeWorkspaceColor((msg) => {
      applyColor({ activeWsRef, setActiveWs, setWorkspaces }, msg.workspaceId, msg.color, msg.shade)
      if (msg.by === 'central') announceCentralColor(msg)
    }),
    [activeWsRef, setActiveWs, setWorkspaces],
  )
}

/** Central never recolors silently: a notice names the workspace and the change, with Undo back to the previous color. */
function announceCentralColor(msg: WorkspaceColorMsg): void {
  const { previous } = msg
  showNotice(COLOR_NOTICE_KEY, {
    title: `Central changed the color of "${msg.name ?? 'a workspace'}" to ${describeWorkspaceColor(msg.color, msg.shade)}.`,
    severity: 'info',
    actions: previous ? [{
      label: 'Undo',
      onClick: () => { setWorkspaceColor(msg.workspaceId, { color: previous.color, colorShade: previous.shade }).catch((err: unknown) => reportActionError('undo the workspace color change', msg.workspaceId, err)) },
    }] : undefined,
  })
}

/**
 * Picker action: show the change at once, save it, then settle on what the server answered; a failed
 * save puts the previous color back and rethrows (the caller reports it with its cause).
 */
export function useSetWorkspaceColor(t: ColorTarget, workspaces: readonly Workspace[]): (id: string, change: ColorChange) => Promise<void> {
  const { activeWsRef, setActiveWs, setWorkspaces } = t
  return useCallback(async (id, change) => {
    const target = { activeWsRef, setActiveWs, setWorkspaces }
    const prev = workspaces.find((w) => w.id === id)
    if (!prev) return
    if (change.color) applyColor(target, id, change.color, change.colorShade ?? prev.colorShade ?? 'default')
    else if (change.colorShade) applyColor(target, id, prev.color ?? 'slate', change.colorShade)
    try {
      const saved = await setWorkspaceColor(id, change)
      applyColor(target, id, saved.color, saved.colorShade)
    } catch (err) {
      if (prev.color) applyColor(target, id, prev.color, prev.colorShade ?? 'default')
      throw new Error(`change the workspace color of ${prev.name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  }, [workspaces, activeWsRef, setActiveWs, setWorkspaces])
}
