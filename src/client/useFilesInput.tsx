// State + baris input nama inline FilesNode (New File/Folder dan Rename). Dipisah dari FilesNode:
// shell tinggal memanggil `start(req)` dan menaruh `row` di daftar.
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import FilesInput from './FilesInput'
import { createEntry } from './filesCreate'
import type { InputRequest } from './filesSlots'

interface Deps {
  cwd: string
  listRef: RefObject<HTMLDivElement | null>
  /** Nama yang harus terpilih begitu listing berikutnya mendarat. */
  pendingSel: RefObject<string | null>
  refresh: () => void
  setNotice: (msg: string) => void
  openFile: (path: string, leaf: string) => void
}
type Active = { req: InputRequest; base: string }

/** `start` membuka input, `row` adalah elemen input (null bila tertutup). */
export function useFilesInput(d: Deps): { start: (req: InputRequest) => void; row: ReactNode } {
  const [active, setActive] = useState<Active | null>(null)
  // Input adalah pertanyaan tentang SATU direktori; pindah folder membatalkannya.
  useEffect(() => { setActive(null) }, [d.cwd])

  const start = (req: InputRequest) => setActive({ req, base: req.kind === 'rename' ? d.cwd : (req.base ?? d.cwd) })

  const commit = async (name: string) => {
    const a = active
    setActive(null)
    d.listRef.current?.focus()
    if (!a) return
    if (a.req.kind === 'rename') { await a.req.onCommit(name); return }
    const r = await createEntry(a.base, name, a.req.kind === 'folder')
    if (!r.ok) { d.setNotice(r.notice); return }
    if (r.notice) d.setNotice(r.notice)
    d.pendingSel.current = r.first
    d.refresh()
    if (a.req.kind === 'file') d.openFile(r.target, r.leaf)
  }

  const row = active && (
    <FilesInput
      dir={active.req.kind === 'folder'} base={active.base}
      initial={active.req.kind === 'rename' ? active.req.initial : undefined}
      onCommit={(n) => { void commit(n) }}
      onCancel={(refocus) => { setActive(null); if (refocus) d.listRef.current?.focus() }}
    />
  )
  return { start, row }
}
