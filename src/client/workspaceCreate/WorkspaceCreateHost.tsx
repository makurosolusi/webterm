// Owns which add-workspace dialog is open and registers the ⌘K commands. Mounted once inside
// WorkspaceBar (rendered on the Welcome screen too); other entry points call `openWorkspaceCreate`.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterCommands } from '../commandRegistry'
import { CloneRepoDialog } from './CloneRepoDialog'
import { NewProjectDialog } from './NewProjectDialog'

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
  useEffect(() => {
    listeners.add(setOpen)
    return () => { listeners.delete(setOpen) }
  }, [])
  const commands = useMemo(() => [
    { id: 'workspace.openFolder', label: 'Workspace: Open Folder…', run: () => openFolder.current() },
    { id: 'workspace.clone', label: 'Workspace: Clone Repository…', run: () => setOpen('clone') },
    { id: 'workspace.newProject', label: 'Workspace: New Project…', run: () => setOpen('project') },
  ], [])
  useRegisterCommands(commands)
  const close = () => setOpen(null)
  const openExisting: OpenExisting = (path, id) => { if (id && onOpenWorkspace) onOpenWorkspace(id); else onCreated(path) }
  if (open === 'clone') return <CloneRepoDialog onClose={close} onCreated={onCreated} onOpenExisting={openExisting} />
  if (open === 'project') return <NewProjectDialog onClose={close} onCreated={onCreated} />
  return null
}
