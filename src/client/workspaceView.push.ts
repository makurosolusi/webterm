// `t:'view'` from the central agent (`canvas.show`): this window switches to the named board and,
// with a node id, centres it (canvas mode) or reveals it (tabs mode). The board overview is closed
// either way, so the canvas the agent asked for is what the user actually sees.
//
// Logic lives outside JSX so it can be asserted without a DOM (same reason as `./workspaceCanvasPush`).
import { useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { ViewMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'
import { reported } from './workspaceActionError'
import { subscribeView } from './ws'

export interface ViewTarget {
  activeWsRef: RefObject<Workspace | null>
  /** Raw (rejecting) switch: the failure is reported once, by `useViewPush`, with Retry. */
  onSelect: (id: string) => Promise<void>
  /** Raw (rejecting) focus: centres or reveals the node and closes the board overview. */
  onFocus: (id: string) => Promise<void>
  setBoard: Dispatch<SetStateAction<boolean>>
}

/** Show `workspaceId` (switching only when it is not already on screen), then `nodeId` if given. */
export async function applyView(t: ViewTarget, workspaceId: string, nodeId?: string): Promise<void> {
  if (t.activeWsRef.current?.id !== workspaceId) await t.onSelect(workspaceId)
  if (nodeId) await t.onFocus(nodeId)
  // Also without a node, or one that is gone: the overview would otherwise hide the board.
  t.setBoard(false)
}

/** Apply every view frame for as long as the caller is mounted; failures are reported, not thrown. */
export function useViewPush(t: ViewTarget): void {
  const { activeWsRef, onSelect, onFocus, setBoard } = t
  useEffect(() => {
    const show = reported('show the workspace', (workspaceId: string, nodeId?: string) =>
      applyView({ activeWsRef, onSelect, onFocus, setBoard }, workspaceId, nodeId))
    return subscribeView((msg: ViewMsg) => { void show(msg.workspaceId, msg.nodeId) })
  }, [activeWsRef, onSelect, onFocus, setBoard])
}
