import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { listDir } from './api'

interface Props {
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}

export default function FolderPicker({ initialPath, onPick, onClose }: Props) {
  const [path, setPath] = useState(initialPath ?? '')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])

  // Keep the last good listing on failure (a 404 just means "don't go there").
  const load = (p?: string) => {
    listDir(p).then((r) => { setPath(r.path); setParent(r.parent); setDirs(r.dirs) }).catch(() => {})
  }
  useEffect(() => { load(initialPath) }, [])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} style={{ width: 520, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <DialogHeader className="sr-only"><DialogTitle>Choose a folder</DialogTitle></DialogHeader>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, borderBottom: '1px solid var(--border)' }}>
          <Button
            variant="ghost"
            onClick={() => parent && load(parent)}
            disabled={parent === null}
            style={{ cursor: parent === null ? 'default' : 'pointer', opacity: parent === null ? 0.4 : 1 }}
          >
            ⬆ up
          </Button>
          <span style={{ flex: 1, color: 'var(--muted)', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{path}</span>
        </div>
        <ScrollArea style={{ flex: 1, minHeight: 0 }}>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {dirs.length === 0 && <span style={{ color: 'var(--muted)', fontSize: 12, padding: 6 }}>(no subfolders)</span>}
          {dirs.map((d) => (
            <Button
              variant="ghost"
              className="folder-picker__entry"
              key={d}
              onClick={() => load(path + '/' + d)}
              style={{ textAlign: 'left', background: 'transparent', color: 'var(--text)', border: 'none', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 13, fontFamily: 'monospace' }}
            >
              📁 {d}
            </Button>
          ))}
          </div>
        </ScrollArea>
        <DialogFooter style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 10, borderTop: '1px solid var(--border)' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onPick(path)}>Select this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
