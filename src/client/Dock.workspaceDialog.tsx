import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getActive, getWorkspace, type HttpError } from './api'
import { createWorktree, type CreatedWorktree } from './workspaceWorktree.api'
import { WorktreeResult } from './Dock.workspaceDialog.result'

interface WorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateWorkspace: (name: string, cwd?: string) => void | Promise<void>
  onBrowse: (onPick: (p: string) => void) => void
}

/** The server's own message (a 400 says what is wrong with the input) before the generic one. */
const createErrorText = (err: unknown): string =>
  (err as Partial<HttpError>).serverMessage ?? (err instanceof Error ? err.message : String(err))

/**
 * Form "Create workspace" dari Add > Workspace…; tetap ter-mount saat tertutup supaya isian bertahan.
 * "New branch (worktree)" imitates Orca's Create Worktree dialog: the branch comes from the name
 * unless typed, the start-from ref defaults to the repo's current branch, and the setup output stays
 * visible after creation.
 */
export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [runSetup, setRunSetup] = useState(true)
  const [result, setResult] = useState<CreatedWorktree | null>(null)
  // The dialog stays mounted while closed, so a failure line is hidden (not kept) once it is closed.
  const [dismissed, setDismissed] = useState(0)
  const create = useAction(async () => {
    const name = wsName.trim()
    if (worktree && !wsCwd.trim()) throw new Error('Pick the repository folder to branch from.')
    if (!worktree) {
      // Closed only once the workspace exists: a failure stays here, next to the input it is about.
      await props.onCreateWorkspace(name, wsCwd.trim() || undefined)
      close()
      return
    }
    const created = await createWorktree({
      repo: wsCwd.trim(), title: name, branch: branch.trim() || undefined, base: base.trim() || undefined, runSetup,
    })
    await props.onCreateWorkspace(name, created.path)
    setResult(created) // keep the dialog open on the setup log until the user closes it
  }, { label: 'Create workspace', failure: createErrorText })
  if (!props.open) return null

  const reset = () => { setWsName(''); setWsCwd(''); setBranch(''); setBase(''); setResult(null); setDismissed(create.result?.seq ?? 0) }
  const close = () => { reset(); props.onOpenChange(false) }

  const toggleWorktree = async (on: boolean) => {
    setWorktree(on)
    if (!on || wsCwd.trim()) return
    // Repo defaults to the active workspace's folder ("current workspace cwd").
    const id = await getActive().catch(() => null)
    const ws = id ? await getWorkspace(id).catch(() => null) : null
    if (ws?.cwd) setWsCwd((cur) => cur || ws.cwd!)
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? props.onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create workspace</DialogTitle></DialogHeader>
        {result ? <WorktreeResult result={result} onClose={close} /> : (
          <div className="dock-menu__form">
            <Input placeholder="name" autoFocus value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && wsName.trim()) void create.run() }} />
            <div className="dock-menu__form-row">
              <Input className="flex-1" placeholder={worktree ? 'repository folder' : 'cwd (optional)'} value={wsCwd}
                onChange={(e) => setWsCwd(e.target.value)} />
              <Button variant="ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</Button>
            </div>
            <label className="flex items-center gap-2">
              <Checkbox checked={worktree} onCheckedChange={(v) => void toggleWorktree(v === true)} aria-label="New branch (worktree)" />
              New branch (worktree)
            </label>
            {worktree && (
              <>
                <Input placeholder="branch (default: from name)" value={branch} onChange={(e) => setBranch(e.target.value)} />
                <Input placeholder="base branch (default: current)" value={base} onChange={(e) => setBase(e.target.value)} />
                <label className="flex items-center gap-2">
                  <Checkbox checked={runSetup} onCheckedChange={(v) => setRunSetup(v === true)} aria-label="Run setup script" />
                  Run setup script (webterm.yaml / orca.yaml)
                </label>
              </>
            )}
            {create.result && !create.result.ok && create.result.seq !== dismissed && <ActionResult action={create} />}
            <ActionButton action={create} busyLabel={worktree ? 'Creating worktree…' : 'Creating…'} disabled={!wsName.trim()}>Create</ActionButton>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
