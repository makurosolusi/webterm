// Owns which add-workspace dialog is open and registers the ⌘K commands. Mounted once inside
// WorkspaceBar (rendered on the Welcome screen too); other entry points call `openWorkspaceCreate`.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterCommands } from '../commandRegistry'

// The dialogs load on first use; the host (commands + open state) stays mounted with the board.
const CloneRepoDialog = lazy(() => import('./CloneRepoDialog').then((m) => ({ default: m.CloneRepoDialog })))
const NewProjectDialog = lazy(() => import('./NewProjectDialog').then((m) => ({ default: m.NewProjectDialog })))

export type WorkspaceCreateKind = 'clone' | 'project'

const listeners = new Set<(k: WorkspaceCreateKind) => void>()
/** Opens the Clone repository or New project dialog from anywhere (Welcome, menus). */
export function openWorkspaceCreate(kind: WorkspaceCreateKind): void {
  listeners.forEach((l) => l(kind))
}

/** "Already cloned → Open": switch to its workspace, or make one for the folder when there is none. */
export type OpenExisting = (path: string, workspaceId?: string) => void

export default function WorkspaceCreateHost({ onOpenFolder, onCreated, onOpenWorkspace }: {
  onOpenFolder: () => void
  /** A folder now exists at `path`: make it a workspace and open it. */
  onCreated: (path: string) => void
  /** Switch to an existing workspace. */
  onOpenWorkspace?: (id: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState<WorkspaceCreateKind | null>(null)
  // Ref, so a new callback each parent render does not re-register the commands.
  const openFolder = useRef(onOpenFolder)
  openFolder.current = onOpenFolder
  // What had focus when a dialog opened (the Start link, the + menu item): focus goes back there on close.
  const trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const open = (k: WorkspaceCreateKind) => {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) trigger.current = document.activeElement
      setOpen(k)
    }
    listeners.add(open)
    return () => { listeners.delete(open) }
  }, [])
  const commands = useMemo(() => [
    { id: 'workspace.openFolder', label: 'Workspace: Open Folder…', run: () => openFolder.current() },
    { id: 'workspace.clone', label: 'Workspace: Clone Repository…', run: () => setOpen('clone') },
    { id: 'workspace.newProject', label: 'Workspace: New Project…', run: () => setOpen('project') },
  ], [])
  useRegisterCommands(commands)
  const close = () => {
    setOpen(null)
    const el = trigger.current
    trigger.current = null
    // After the dialog unmounts (Radix restores focus too, but not after the folder-picker swap).
    if (el) setTimeout(() => { if (el.isConnected) el.focus() }, 0)
  }
  const openExisting: OpenExisting = (path, id) => { if (id && onOpenWorkspace) onOpenWorkspace(id); else onCreated(path) }
  if (open === 'clone') return <Suspense fallback={null}><CloneRepoDialog onClose={close} onCreated={onCreated} onOpenExisting={openExisting} /></Suspense>
  if (open === 'project') return <Suspense fallback={null}><NewProjectDialog onClose={close} onCreated={onCreated} /></Suspense>
  return null
}
