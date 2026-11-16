// Clone repository: URL (owner/repo shorthand previewed as the
// GitHub URL), parent folder (last used remembered), live progress, inline error; Cancel or closing
// the dialog aborts the clone and the server deletes the half-cloned folder. Also:
// an editable folder name, the full target path, a preflight (already cloned / name taken / wrong
// place, see useCreateFlow) and a success state with Reveal in Finder and Copy path.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FolderPicker from '../FolderPicker'
import { deriveRepoDirName, expandCloneUrl, isValidCloneUrl, type CloneProgress } from '../../server/workspaceCreate/cloneUrl'
import { CreatedPanel, CreateNotice, TargetPath } from './CreateNotices'
import { useCreateFlow } from './useCreateFlow'
import { cancelClone, cloneRepo, initialParent, PARENT_KEY, rememberParent } from './workspaceCreate.api'
import { ParentField } from './ParentField'
import type { OpenExisting } from './WorkspaceCreateHost'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function CloneRepoDialog({ onClose, onCreated, onOpenExisting }: {
  onClose: () => void
  onCreated: (path: string) => void
  onOpenExisting: OpenExisting
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [name, setName] = useState<string | null>(null) // null = follow the URL
  const [parent, setParent] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => { void initialParent(PARENT_KEY).then((p) => setParent((cur) => cur || p), (e) => setLoadError(errText(e))) }, [])

  const expanded = expandCloneUrl(url)
  const folder = name ?? deriveRepoDirName(expanded) ?? ''
  const valid = isValidCloneUrl(expanded)

  const run = async (): Promise<string> => {
    setCloning(true)
    setProgress(null)
    try {
      const path = await cloneRepo({ url: expanded, parent: parent.trim(), name: folder.trim() }, setProgress)
      rememberParent(parent.trim(), PARENT_KEY)
      return path
    } finally {
      setCloning(false)
    }
  }
  // Cancel answers `aborted` while the dialog is already closing: stay silent.
  const flow = useCreateFlow({ parent: parent.trim(), name: folder.trim(), url: expanded }, run, onCreated, (e) => (e as { code?: string }).code === 'aborted')
  // A new URL drops every answer; a new folder keeps "clone again anyway" (it was about the repo).
  const edit = <T,>(set: (v: T) => void, keepExisting = true) => (v: T) => { set(v); flow.reset(keepExisting) }
  const canClone = !flow.busy && valid && parent.trim() !== '' && folder.trim() !== ''
  const cloneLock = flow.busy ? undefined : !valid ? 'Enter a repository URL first.' : folder.trim() === '' ? 'Enter a folder name first.'
    : parent.trim() === '' ? 'Choose a parent folder first.' : undefined

  const cancel = (): void => {
    if (cloning) void cancelClone()
    onClose()
  }

  if (browsing) return <FolderPicker initialPath={parent || undefined} onPick={(p) => { edit(setParent)(p); setBrowsing(false) }} onClose={() => setBrowsing(false)} />

  return (
    <Dialog open onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent className="sm:max-w-lg" data-testid="clone-repo-dialog">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>Private repositories use your git credentials (`gh auth login` or an SSH key).</DialogDescription>
        </DialogHeader>
        {flow.created ? <CreatedPanel path={flow.created} onDone={onClose} /> : (
          <form className="flex flex-col gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); if (canClone) void flow.submit() }}>
            <div className="flex flex-col gap-1">
              <Label htmlFor="clone-url">Repository URL</Label>
              <Input id="clone-url" autoFocus value={url} spellCheck={false} disabled={flow.busy}
                placeholder="https://github.com/user/repo.git — or user/repo" onChange={(e) => edit(setUrl, false)(e.target.value)} />
              {url.trim() !== '' && expanded !== url.trim() && <span className="opacity-70">→ {expanded}</span>}
              {url.trim() !== '' && !valid && <span className="text-(--vscode-errorForeground)">Use an https:// or git@host:owner/repo URL, or owner/repo for GitHub.</span>}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="clone-name">Folder name</Label>
              <Input id="clone-name" value={folder} spellCheck={false} disabled={flow.busy} onChange={(e) => edit(setName)(e.target.value)} />
            </div>
            <ParentField id="clone-parent" value={parent} busy={flow.busy} onChange={edit(setParent)} onBrowse={() => setBrowsing(true)} />
            <TargetPath parent={parent} name={folder} />
            {flow.notice && (
              <CreateNotice notice={flow.notice} verb="Clone"
                onOpenExisting={() => { const ex = flow.notice?.pre.existing; if (ex) { onOpenExisting(ex.path, ex.workspaceId); onClose() } }}
                onUseName={(n) => edit(setName)(n)} onProceed={(ack) => void flow.submit(ack)} />
            )}
            {(flow.error || loadError) && <p className="text-(--vscode-errorForeground)" role="alert">{flow.error || loadError}</p>}
            {cloning && (
              <div className="flex flex-col gap-1" data-testid="clone-progress">
                <span>{progress ? `${progress.phase}… ${progress.percent}%` : 'Starting clone…'}</span>
                <div className="h-1 w-full rounded bg-muted">
                  <div className="h-1 rounded bg-primary" style={{ width: `${progress?.percent ?? 3}%` }} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
              <IconTooltip label="Clone" disabled={!canClone} disabledReason={cloneLock}>
                <Button type="submit" disabled={!canClone}>{cloning ? 'Cloning…' : 'Clone'}</Button>
              </IconTooltip>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
