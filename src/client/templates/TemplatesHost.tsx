// ⌘K host of the template dialogs (TemplatesDialogs.tsx): registers both commands and owns which is open.
import { lazy, Suspense, useMemo, useState } from 'react'
import { useRegisterCommands } from '../commandRegistry'
import type { BridgeLink, Workspace, WsNode } from '../../shared/workspace'
import { TEMPLATES_TEXT as T } from './templates.client'

export interface TemplatesHostProps {
  activeWs: Workspace | null
  /** A new workspace was made on the server: show and switch to it. */
  onCreated: (ws: Workspace) => void
  /** Nodes for the ACTIVE canvas (the client owns it; the server never saved them). */
  onPlace: (nodes: WsNode[], bridges: BridgeLink[]) => void
}

// The dialogs load on first open; this host stays mounted with the board for the commands.
const NewFromTemplateDialog = lazy(() => import('./TemplatesDialogs').then((m) => ({ default: m.NewFromTemplateDialog })))
const SaveAsTemplateDialog = lazy(() => import('./TemplatesDialogs').then((m) => ({ default: m.SaveAsTemplateDialog })))

/** Registers both ⌘K commands and owns which dialog is open; mounted once in App. */
export default function TemplatesHost(props: TemplatesHostProps): React.JSX.Element | null {
  const [open, setOpen] = useState<'new' | 'save' | null>(null)
  const commands = useMemo(() => [
    { id: 'templates.new', label: T.newCommand, run: () => setOpen('new') },
    { id: 'templates.save', label: T.saveCommand, run: () => setOpen('save') },
  ], [])
  useRegisterCommands(commands)
  if (open === 'new') return <Suspense fallback={null}><NewFromTemplateDialog {...props} onClose={() => setOpen(null)} /></Suspense>
  if (open === 'save' && props.activeWs) return <Suspense fallback={null}><SaveAsTemplateDialog ws={props.activeWs} onClose={() => setOpen(null)} /></Suspense>
  return null
}
