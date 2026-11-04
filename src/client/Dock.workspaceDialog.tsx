import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface WorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateWorkspace: (name: string, cwd?: string) => void
  onBrowse: (onPick: (p: string) => void) => void
}

/** Form "Create workspace" dari Add > Workspace…; tetap ter-mount saat tertutup supaya isian bertahan. */
export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')
  if (!props.open) return null

  const createWs = () => {
    if (!wsName.trim()) return
    props.onCreateWorkspace(wsName.trim(), wsCwd.trim() || undefined)
    setWsName(''); setWsCwd(''); props.onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create workspace</DialogTitle></DialogHeader>
        <div className="dock-menu__form">
          <Input placeholder="name" autoFocus value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createWs() }} />
          <div className="dock-menu__form-row">
            <Input className="flex-1" placeholder="cwd (optional)" value={wsCwd}
              onChange={(e) => setWsCwd(e.target.value)} />
            <Button variant="ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</Button>
          </div>
          <Button onClick={createWs}>Create</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
