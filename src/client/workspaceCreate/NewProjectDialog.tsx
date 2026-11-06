// New project, after Orca's AddRepoCreateStep: name + parent folder, "Create project" makes the
// folder and (default on, Orca kind:'git') runs `git init` with an empty initial commit. Nothing else
// is written: Orca adds no README or .gitignore, so neither do we. Same preflight and success state
// as Clone repository (useCreateFlow / CreateNotices).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FolderPicker from '../FolderPicker'
import { CreatedPanel, CreateNotice, TargetPath } from './CreateNotices'
import { useCreateFlow } from './useCreateFlow'
import { createProject, initialParent, PROJECT_PARENT_KEY, rememberParent } from './workspaceCreate.api'
import { ParentField } from './ParentField'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => { void initialParent(PROJECT_PARENT_KEY).then((p) => setParent((cur) => cur || p), (e) => setLoadError(errText(e))) }, [])

  const run = async (): Promise<string> => {
    const path = await createProject({ parent: parent.trim(), name: name.trim(), gitInit })
    rememberParent(parent.trim(), PROJECT_PARENT_KEY)
    return path
  }
  const flow = useCreateFlow({ parent: parent.trim(), name: name.trim() }, run, onCreated)
  const edit = (set: (v: string) => void) => (v: string) => { set(v); flow.reset() }
  const canCreate = !flow.busy && name.trim() !== '' && parent.trim() !== ''

  if (browsing) return <FolderPicker initialPath={parent || undefined} onPick={(p) => { edit(setParent)(p); setBrowsing(false) }} onClose={() => setBrowsing(false)} />

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !flow.busy) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Creates an empty folder and opens it as a workspace.</DialogDescription>
        </DialogHeader>
        {flow.created ? <CreatedPanel path={flow.created} onDone={onClose} /> : (
          <form className="flex flex-col gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); if (canCreate) void flow.submit() }}>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-project-name">Project name</Label>
              <Input id="new-project-name" autoFocus value={name} spellCheck={false} disabled={flow.busy} placeholder="my-project" onChange={(e) => edit(setName)(e.target.value)} />
            </div>
            <ParentField id="new-project-parent" value={parent} disabled={flow.busy} onChange={edit(setParent)} onBrowse={() => setBrowsing(true)} />
            <TargetPath parent={parent} name={name} />
            <div className="flex items-center gap-2">
              <Checkbox id="new-project-git" checked={gitInit} disabled={flow.busy} onCheckedChange={(c) => setGitInit(c === true)} />
              <Label htmlFor="new-project-git">Initialize git repository</Label>
            </div>
            {flow.notice && (
              <CreateNotice notice={flow.notice} verb="Create" onUseName={edit(setName)} onProceed={(ack) => void flow.submit(ack)} />
            )}
            {(flow.error || loadError) && <p className="text-(--vscode-errorForeground)" role="alert">{flow.error || loadError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={flow.busy} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!canCreate}>{flow.busy ? 'Creating…' : 'Create project'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
