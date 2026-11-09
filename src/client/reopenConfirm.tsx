// The confirm gate for reopening a session from a "Recently closed" list (side bar, Welcome). A
// list row is easy to click by accident, and the reopen can switch workspace, so the click asks
// first. Undo (canvasUndo.ts) and a menu item named "Reopen" already say what they do: they call
// the reopen directly and never come here.
//
// Same mechanism as nodeCloseConfirm.tsx (module-level pending request + useSyncExternalStore, one
// VscodeDialog host in App.hosts.tsx). One difference: a second request replaces the open one (the
// earlier resolves false), because the newest click is the one the user means.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { Button } from './components/ui/button'
import { sessionLabel } from './sessionList'
import type { ClosedEntry } from './closedHistory'

/** Title and body for reopening `entry`. `activeWorkspaceId`: the workspace on the board (`null` =
 *  none); `undefined` = unknown, and the body then only names the workspace. */
export function reopenCopy(entry: ClosedEntry, activeWorkspaceId?: string | null): { title: string; body: string } {
  const title = `Reopen “${sessionLabel(entry.node)}”?`
  if (activeWorkspaceId === entry.workspaceId) return { title, body: 'It opens again on this board.' }
  if (activeWorkspaceId === undefined) return { title, body: `It opens again in workspace ${entry.workspaceName}.` }
  return { title, body: `It opens again in workspace ${entry.workspaceName}, and webterm switches to that workspace.` }
}

interface Pending { entry: ClosedEntry; activeWorkspaceId?: string | null; resolve: (ok: boolean) => void }
let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of listeners) l() }
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Ask before reopening `entry`. Resolves true to reopen. A request made while one is open
 *  replaces it; the earlier one resolves false. */
export function confirmReopen(entry: ClosedEntry, activeWorkspaceId?: string | null): Promise<boolean> {
  const prev = pending
  return new Promise((resolve) => {
    pending = { entry, activeWorkspaceId, resolve }
    prev?.resolve(false)
    emit()
  })
}

/** Answer the open dialog, if any. */
export function answerReopen(ok: boolean): void {
  const p = pending
  if (!p) return
  pending = null
  emit()
  p.resolve(ok)
}

/** The dialog. Mounted once (App.hosts.tsx); renders nothing until a reopen is asked. Unmounting it
 *  cancels an open request, so no caller waits forever. */
export function ReopenConfirmHost(): React.JSX.Element | null {
  const req = useSyncExternalStore(subscribe, () => pending)
  useEffect(() => () => answerReopen(false), [])
  return req ? <ReopenDialog req={req} /> : null
}

function ReopenDialog({ req }: { req: Pending }): React.JSX.Element {
  const reopenRef = useRef<HTMLButtonElement>(null)
  const { title, body } = reopenCopy(req.entry, req.activeWorkspaceId)
  const reopen = <Button key="reopen" ref={reopenRef} onClick={() => answerReopen(true)}>Reopen</Button>
  const cancel = <Button key="cancel" variant="secondary" onClick={() => answerReopen(false)}>Cancel</Button>
  return (
    <VscodeDialog
      open onOpenChange={(open) => { if (!open) answerReopen(false) }}
      title={title} description={body} width={420}
      // Reopening loses nothing, so the primary answer takes focus and Enter reopens.
      initialFocus={reopenRef}
      footer={arrangeDialogButtons([reopen, cancel], 1)}
    />
  )
}
