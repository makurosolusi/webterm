// New project, after Orca's AddRepoCreateStep: name + parent folder, "Create project" makes the
// folder and (default on, Orca kind:'git') runs `git init` with an empty initial commit. Nothing else
// is written: Orca adds no README or .gitignore, so neither do we.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FolderPicker from '../FolderPicker'
import { createProject, initialParent, rememberParent } from './workspaceCreate.api'
import { ParentField } from './ParentField'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void initialParent().then((p) => setParent((cur) => cur || p), (e) => setError(errText(e))) }, [])

  const canCreate = !busy && name.trim() !== '' && parent.trim() !== ''
  const create = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setError('')
    try {
      const path = await createProject({ parent: parent.trim(), name: name.trim(), gitInit })
      rememberParent(parent.trim())
      onCreated(path)
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (browsing) return <FolderPicker initialPath={parent || undefined} onPick={(p) => { setParent(p); setBrowsing(false) }} onClose={() => setBrowsing(false)} />

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Creates an empty folder and opens it as a workspace.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-project-name">Project name</Label>
            <Input id="new-project-name" autoFocus value={name} spellCheck={false} disabled={busy} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
          </div>
          <ParentField id="new-project-parent" value={parent} disabled={busy} onChange={setParent} onBrowse={() => setBrowsing(true)} />
          <div className="flex items-center gap-2">
            <Checkbox id="new-project-git" checked={gitInit} disabled={busy} onCheckedChange={(c) => setGitInit(c === true)} />
            <Label htmlFor="new-project-git">Initialize git repository</Label>
          </div>
          {error && <p className="text-red-600" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canCreate}>{busy ? 'Creating…' : 'Create project'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
