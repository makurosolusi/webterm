// ⌘K host of the session replay dialog (ReplayDialog.tsx): registers the command and owns the open state.
import { lazy, Suspense, useMemo, useState } from 'react'
import { useRegisterCommands } from '../commandRegistry'
import type { ReplayNode } from './ReplayDialog'
import { REPLAY_TEXT as T } from './replay.client'

// The dialog loads on first open; this host stays mounted with the board for the command.
const ReplayDialog = lazy(() => import('./ReplayDialog').then((m) => ({ default: m.ReplayDialog })))

/** Registers the ⌘K command and owns the dialog's open state; mounted once in App. */
export default function ReplayHost({ workspaceId, nodes }: { workspaceId: string | null; nodes: readonly ReplayNode[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const commands = useMemo(() => [{ id: 'replay.open', label: T.command, run: () => setOpen(true) }], [])
  useRegisterCommands(commands)
  return open && workspaceId ? <Suspense fallback={null}><ReplayDialog workspaceId={workspaceId} nodes={nodes} onClose={() => setOpen(false)} /></Suspense> : null
}
