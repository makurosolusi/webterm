// ⌘K host of the bake-off dialog (BakeoffDialog.tsx): registers the command and owns the open state.
import { lazy, Suspense, useMemo, useState } from 'react'
import { useRegisterCommands } from '../commandRegistry'
import { BAKEOFF_TEXT as T } from './bakeoff.client'

// The dialog loads on first open; this host stays mounted with the board for the command.
const BakeoffDialog = lazy(() => import('./BakeoffDialog').then((m) => ({ default: m.BakeoffDialog })))

/** Registers the ⌘K command and owns the dialog's open state; mounted once in App. */
export default function BakeoffHost({ repo, workspaceId }: { repo?: string; workspaceId?: string | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const commands = useMemo(() => [{ id: 'bakeoff.open', label: T.command, run: () => setOpen(true) }], [])
  useRegisterCommands(commands)
  return open ? <Suspense fallback={null}><BakeoffDialog repo={repo} workspaceId={workspaceId} onClose={() => setOpen(false)} /></Suspense> : null
}
