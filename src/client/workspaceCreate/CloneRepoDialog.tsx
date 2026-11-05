// Clone repository, after nodeterm CloneRepoDialog.tsx: URL (owner/repo shorthand previewed as the
// GitHub URL), parent folder (last used remembered), live progress, inline error; Cancel or closing
// the dialog aborts the clone and the server deletes the half-cloned folder. Added over nodeterm:
// an editable folder name (Orca and the task ask for it).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import FolderPicker from '../FolderPicker'
import { deriveRepoDirName, expandCloneUrl, isValidCloneUrl, type CloneProgress } from '../../server/workspaceCreate/cloneUrl'
import { cancelClone, cloneRepo, initialParent, rememberParent } from './workspaceCreate.api'
import { ParentField } from './ParentField'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function CloneRepoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [name, setName] = useState<string | null>(null) // null = follow the URL
  const [parent, setParent] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { void initialParent().then((p) => setParent((cur) => cur || p), (e) => setError(errText(e))) }, [])

  const expanded = expandCloneUrl(url)
  const folder = name ?? deriveRepoDirName(expanded) ?? ''
  const valid = isValidCloneUrl(expanded)
  const canClone = !cloning && valid && parent.trim() !== '' && folder.trim() !== ''

  const start = async (): Promise<void> => {
    if (!canClone) return
    setCloning(true)
    setError('')
    setProgress(null)
    try {
      const path = await cloneRepo({ url: expanded, parent: parent.trim(), name: folder.trim() }, setProgress)
      rememberParent(parent.trim())
      onCreated(path)
      onClose()
    } catch (e) {
      // Cancel answers `aborted` while the dialog is already closing: stay silent (nodeterm).
      if ((e as { code?: string }).code !== 'aborted') setError(errText(e))
    } finally {
      setCloning(false)
    }
  }

  const cancel = (): void => {
    if (cloning) void cancelClone()
    onClose()
  }

  if (browsing) return <FolderPicker initialPath={parent || undefined} onPick={(p) => { setParent(p); setBrowsing(false) }} onClose={() => setBrowsing(false)} />

  return (
    <Dialog open onOpenChange={(o) => { if (!o) cancel() }}>
      <DialogContent className="sm:max-w-lg" data-testid="clone-repo-dialog">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>Private repositories use your git credentials (`gh auth login` or an SSH key).</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); void start() }}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="clone-url">Repository URL</Label>
            <Input id="clone-url" autoFocus value={url} spellCheck={false} disabled={cloning}
              placeholder="https://github.com/user/repo.git — or user/repo" onChange={(e) => setUrl(e.target.value)} />
            {url.trim() !== '' && expanded !== url.trim() && <span className="opacity-70">→ {expanded}</span>}
            {url.trim() !== '' && !valid && <span className="text-red-600">Use an https:// or git@host:owner/repo URL, or owner/repo for GitHub.</span>}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="clone-name">Folder name</Label>
            <Input id="clone-name" value={folder} spellCheck={false} disabled={cloning} onChange={(e) => setName(e.target.value)} />
          </div>
          <ParentField id="clone-parent" value={parent} disabled={cloning} onChange={setParent} onBrowse={() => setBrowsing(true)} />
          {error && <p className="text-red-600" role="alert">{error}</p>}
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
            <Button type="submit" disabled={!canClone}>{cloning ? 'Cloning…' : 'Clone'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
