// Boot of the workspace list + active board as an explicit loading / error / ready machine
// (ui-210-3). A failure that is not the auth gate's 403 used to be rethrown into a fire-and-forget
// promise and left a blank page; now it is shown with its cause and a Retry, and retried on its own
// with backoff while the server restarts (VS Code "cannot connect … Reload Window").
//
// The board is fetched COMPLETE before any state is committed: React Flow reads `defaultViewport`
// only at mount, so committing the id first would mount the canvas with the default viewport and
// no nodes, the stored board arriving one render later.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { fetchWorkspaces, getActive, getWorkspace, setActive } from './api'
import { bootWorkspaceId } from './workspaceMenu'
import { reconnectDelay } from './ws.connection'
import type { Workspace } from '../shared/workspace'

const HTTP_FORBIDDEN = 403

export type BootState =
  | { kind: 'loading' }
  /** `retryAt` = epoch ms of the next automatic attempt. */
  | { kind: 'error'; message: string; retryAt: number }
  | { kind: 'ready' }

export interface WorkspaceBootDeps {
  applyWorkspace: (ws: Workspace) => void
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
  setHydrated: Dispatch<SetStateAction<boolean>>
  /** Raised when the boot fetch answers 403: this browser has no UI session → App renders SignInScreen. */
  setAuthRequired: Dispatch<SetStateAction<boolean>>
  /** Board named by the URL (`/w/:id`): wins over the server's active board when it exists. */
  urlWorkspaceId?: string | null
}

/** Board to open at boot: the URL's id when it is a workspace, else the server's active one, else the first. */
export function pickBootWorkspace(ids: string[], urlId: string | null | undefined, active: string | null): string | null {
  return bootWorkspaceId(ids, urlId && ids.includes(urlId) ? urlId : active)
}

export interface WorkspaceBoot {
  boot: BootState
  /** Run the boot again now (the error screen's Retry). */
  retryBoot: () => void
}

export function useWorkspaceBoot({ applyWorkspace, setWorkspaces, setHydrated, setAuthRequired, urlWorkspaceId }: WorkspaceBootDeps): WorkspaceBoot {
  // Read when a run starts, not an effect dep: after boot the URL follows the board (`App.route`), it must not re-run boot.
  const urlId = useRef(urlWorkspaceId)
  urlId.current = urlWorkspaceId
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' })
  const [run, setRun] = useState({ n: 0, failures: 0 }) // a new `n` re-runs the effect
  const retryBoot = useCallback(() => setRun((r) => ({ n: r.n + 1, failures: r.failures })), [])

  useEffect(() => {
    let stale = false // a later run (Retry, unmount) owns the state now
    let timer: ReturnType<typeof setTimeout> | null = null
    setBoot({ kind: 'loading' })
    void (async () => {
      try {
        const [list, active] = await Promise.all([fetchWorkspaces(), getActive()])
        const id = pickBootWorkspace(list.map((w) => w.id), urlId.current, active)
        const ws = id ? await getWorkspace(id) : null
        if (id && id !== active) await setActive(id) // a URL-chosen board becomes the server's active one, so a bare `/` reopens it
        if (stale) return
        setWorkspaces(list.map((w) => (w.id === ws?.id ? ws : w)))
        if (ws) applyWorkspace(ws)
        setBoot({ kind: 'ready' })
        setHydrated(true)
      } catch (e) {
        if (stale) return
        // 403 = the server gate refused this browser (no live session cookie): this boot fetch doubles as the auth probe, so
        // there is no separate round trip. `hydrated` is raised too, or App never leaves loading.
        if ((e as { status?: number }).status === HTTP_FORBIDDEN) { setAuthRequired(true); setHydrated(true); return }
        console.error('[webterm] loading workspaces failed, retrying:', e)
        const delay = reconnectDelay(run.failures)
        setBoot({ kind: 'error', message: e instanceof Error ? e.message : String(e), retryAt: Date.now() + delay })
        timer = setTimeout(() => setRun((r) => ({ n: r.n + 1, failures: r.failures + 1 })), delay)
      }
    })()
    return () => { stale = true; if (timer) clearTimeout(timer) }
  }, [applyWorkspace, run])

  return { boot, retryBoot }
}
