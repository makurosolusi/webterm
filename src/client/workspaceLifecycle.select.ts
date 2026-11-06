// Workspace switching where the LAST click wins (data-209-11, ui-210-5), VS Code editor-open style:
// every switch gets a token and an AbortController, a newer switch aborts the older GET, and a
// result that arrives after a newer click is dropped. The guard compares with the board the newest
// switch is heading to (or the board on screen), never with a render-time `activeId` closure,
// which made "B then back to A" a no-op that ended on B. `PUT /api/active` calls run in click
// order, so the server's active board ends on the last click too.
import { useCallback, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { getWorkspace, setActive } from './api'
import type { Workspace } from '../shared/workspace'

export interface LatestSelectDeps {
  activeWsRef: RefObject<Workspace | null>
  applyWorkspace: (ws: Workspace) => void
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
}

export interface LatestSelect {
  /** Switch to `id`; resolves without effect when a newer switch superseded it. */
  onSelect: (id: string) => Promise<void>
  /** Drop the pending switch (delete/create mount their own board). */
  cancelSelect: () => void
  /** `setActive`, queued behind the ones already sent so the server sees them in order. */
  setActiveInOrder: (id: string) => Promise<void>
}

export const isAbortError = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

export function useLatestSelect({ activeWsRef, applyWorkspace, setWorkspaces }: LatestSelectDeps): LatestSelect {
  const seq = useRef(0)
  const target = useRef<string | null>(null) // board the newest pending switch is heading to
  const ctrl = useRef<AbortController | null>(null)
  const activeChain = useRef<Promise<unknown>>(Promise.resolve())

  const setActiveInOrder = useCallback((id: string) => {
    const next = activeChain.current.catch(() => undefined).then(() => setActive(id))
    activeChain.current = next
    return next
  }, [])

  const cancelSelect = useCallback(() => {
    seq.current++
    ctrl.current?.abort()
    ctrl.current = null
    target.current = null
  }, [])

  const onSelect = useCallback(async (id: string) => {
    if (!id) return
    const shown = activeWsRef.current?.id ?? null
    if (id === (target.current ?? shown)) return
    const pendingElsewhere = target.current !== null
    cancelSelect()
    const mine = seq.current
    if (id === shown) {
      // Back to the board on screen while another switch was pending: nothing to load, but the
      // server may already have been told about the abandoned target.
      if (pendingElsewhere) await setActiveInOrder(id)
      return
    }
    target.current = id
    const ac = new AbortController()
    ctrl.current = ac
    try {
      const ws = await getWorkspace(id, ac.signal)
      if (mine !== seq.current) return
      await setActiveInOrder(id)
      if (mine !== seq.current) return
      target.current = null
      ctrl.current = null
      setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? ws : w)))
      applyWorkspace(ws)
    } catch (e) {
      if (mine !== seq.current || isAbortError(e)) return
      target.current = null
      ctrl.current = null
      throw e
    }
  }, [activeWsRef, applyWorkspace, setWorkspaces, cancelSelect, setActiveInOrder])

  return { onSelect, cancelSelect, setActiveInOrder }
}
