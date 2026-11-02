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
      {/* `max-w` di-override di breakpoint `sm` karena bawaan DialogContent (`sm:max-w-lg` = 512px)
          akan memotong lebar 520px di layar sempit-menetang. flex-col + overflow-hidden menjaga
          daftar folder satu-satunya area yang menggulir. */}
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[70vh] w-[520px] max-w-[calc(100%-2rem)] flex-col overflow-hidden sm:max-w-[520px]"
      >
        <DialogHeader className="sr-only"><DialogTitle>Choose a folder</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2 border-b border-border p-2.5">
          <Button
            variant="ghost"
            onClick={() => parent && load(parent)}
            disabled={parent === null}
            className="disabled:opacity-40"
          >
            ⬆ up
          </Button>
          {/* `direction: rtl` menahan ekor path tetap terlihat saat terpotong; `text-left` menjaga
              urutan karakternya tetap kiri-ke-kanan. */}
          <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground [direction:rtl]">{path}</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 p-2">
          {dirs.length === 0 && <span className="p-1.5 text-xs text-muted-foreground">(no subfolders)</span>}
          {dirs.map((d) => (
            <Button
              variant="ghost"
              className="h-auto w-full min-w-0 justify-start rounded bg-transparent px-2 py-1.5 text-left font-mono text-[13px] text-foreground hover:bg-transparent"
              key={d}
              onClick={() => load(path + '/' + d)}
            >
              📁 {d}
            </Button>
          ))}
          </div>
        </ScrollArea>
        <DialogFooter className="flex-row justify-end border-t border-border p-2.5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onPick(path)}>Select this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
