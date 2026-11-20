// New project, after Orca's AddRepoCreateStep: name + parent folder, "Create project" makes the
// folder and (default on, Orca kind:'git') runs `git init` with an empty initial commit. Nothing else
// is written: Orca adds no README or .gitignore, so neither do we. Same preflight and success state
// as Clone repository (useCreateFlow / CreateNotices).
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FolderPicker from '../FolderPicker'
import { CreatedPanel, CreateNotice, TargetPath } from './CreateNotices'
import { GitInitOption } from './GitInitOption'
import { InlineAlert } from './InlineAlert'
import { projectNameError } from './projectName'
import { useCreateFlow } from './useCreateFlow'
import { createProject, initialParent, PROJECT_PARENT_KEY, rememberParent } from './workspaceCreate.api'
import { CREATE_TEXT } from './workspaceCreate.labels'
import { ParentField } from './ParentField'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const T = CREATE_TEXT.newProject

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [touched, setTouched] = useState(false)
  const [bootstrap, setBootstrap] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void initialParent(PROJECT_PARENT_KEY).then((p) => setParent((cur) => cur || p), (e) => setLoadError(errText(e))) }, [])

  const run = async (): Promise<string> => {
    const r = await createProject({ parent: parent.trim(), name: name.trim(), gitInit })
    rememberParent(parent.trim(), PROJECT_PARENT_KEY)
    setBootstrap(r.bootstrapIdentity)
    return r.path
  }
  const flow = useCreateFlow({ parent: parent.trim(), name: name.trim() }, run, onCreated)
  const edit = (set: (v: string) => void) => (v: string) => { set(v); flow.reset() }
  const nameError = projectNameError(name, touched)
  const canCreate = !flow.busy && name.trim() !== '' && parent.trim() !== '' && projectNameError(name) === ''
  const createLock = flow.busy ? undefined : name.trim() === '' ? T.needName : projectNameError(name) ? T.fixName : parent.trim() === '' ? T.needParent : undefined

  if (browsing) return <FolderPicker initialPath={parent || undefined} onPick={(p) => { edit(setParent)(p); setBrowsing(false) }} onClose={() => setBrowsing(false)} />

  const shownError = flow.error || loadError
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !flow.busy) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="new-project-dialog" onOpenAutoFocus={(e) => { e.preventDefault(); nameRef.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.description}</DialogDescription>
        </DialogHeader>
        {flow.created ? <div className="px-3 pb-2"><CreatedPanel path={flow.created} onDone={onClose} bootstrapIdentity={bootstrap} /></div> : (
          <form className="flex flex-col gap-4 px-3 pb-2 text-xs" noValidate aria-busy={flow.busy} onSubmit={(e) => { e.preventDefault(); setTouched(true); if (canCreate) void flow.submit() }}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-project-name">{T.nameLabel}</Label>
              <Input id="new-project-name" ref={nameRef} value={name} spellCheck={false} autoComplete="off" disabled={flow.busy} placeholder={T.namePlaceholder}
                aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? 'new-project-name-error' : undefined}
                onBlur={() => setTouched(true)} onChange={(e) => edit(setName)(e.target.value)} />
              {nameError && <p id="new-project-name-error" className="m-0 leading-4 text-(--vscode-errorForeground)" data-testid="name-error">{nameError}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <ParentField id="new-project-parent" value={parent} busy={flow.busy} onChange={edit(setParent)} onBrowse={() => setBrowsing(true)} />
              <TargetPath parent={parent} name={name} />
            </div>
            <GitInitOption checked={gitInit} disabled={flow.busy} onChange={setGitInit} />
            <div className="flex flex-col gap-2 empty:hidden" aria-live="polite">
              {flow.notice && <CreateNotice notice={flow.notice} verb="Create" onUseName={edit(setName)} onProceed={(ack) => void flow.submit(ack)} />}
              {shownError && <InlineAlert message={shownError} />}
            </div>
            <DialogFooter className="px-0 pb-0 pt-0">
              <Button type="button" variant="outline" disabled={flow.busy} onClick={onClose}>{CREATE_TEXT.cancel}</Button>
              <IconTooltip label={T.submit} disabled={!canCreate} disabledReason={createLock}>
                <Button type="submit" disabled={!canCreate}>
                  {flow.busy && <span className="codicon codicon-loading codicon-modifier-spin motion-reduce:animate-none" aria-hidden />}
                  {flow.busy ? T.submitting : T.submit}
                </Button>
              </IconTooltip>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
