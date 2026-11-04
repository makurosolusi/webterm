// Dialog Quick Open (WS-FM-09): daftar file diminta SEKALI per pembukaan, lalu dicocokkan fuzzy di
// klien. ↑/↓ pindah, Enter membuka, Esc menutup (Radix Dialog). Dirender di portal, jadi tidak ikut
// transform viewport React Flow.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fuzzyFilter } from './fuzzy'
import { search } from './fsClient'

/** Satu-satunya tempat string UI Quick Open (Inggris). */
export const QUICK_TEXT = {
  title: 'Quick Open',
  description: 'Type to search files in this folder, Enter to open.',
  placeholder: 'Search files…',
  loading: 'Loading file list…',
  failed: 'Could not load the file list: ',
  none: 'No matching files.',
  truncated: 'List truncated; narrow your search.',
}
/** Nilai `q` yang berarti "semua file" (dispatcher mewajibkan `q` non-kosong). */
export const QUICK_OPEN_MATCH_ALL = '*'
/** Jumlah hasil yang ditampilkan sekaligus. */
export const QUICK_OPEN_SHOWN = 50

interface Props {
  root: string
  onOpen(rel: string): void
  onClose(): void
}
type Loaded = { files: string[]; truncated: boolean } | { error: string } | null

export default function QuickOpen({ root, onOpen, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    let alive = true
    void search(root, QUICK_OPEN_MATCH_ALL).then((r) => {
      if (alive) setLoaded(r.ok ? { files: r.files, truncated: r.truncated } : { error: r.error })
    })
    return () => { alive = false }
  }, [root])

  const files = loaded && 'files' in loaded ? loaded.files : null
  const results = useMemo(() => (files ? fuzzyFilter(query.trim(), files, QUICK_OPEN_SHOWN) : []), [files, query])
  const at = Math.min(active, Math.max(results.length - 1, 0))

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Papan ketik di sini milik dialog; jangan bocor ke canvas (panah mem-pan, Backspace menghapus node).
    e.stopPropagation()
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)) }
    else if (e.key === 'Enter' && results[at]) { e.preventDefault(); onOpen(results[at]); onClose() }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false} className="files-quickopen">
        <DialogTitle className="sr-only">{QUICK_TEXT.title}</DialogTitle>
        <DialogDescription className="sr-only">{QUICK_TEXT.description}</DialogDescription>
        <Input
          autoFocus role="combobox" aria-expanded aria-controls="files-quickopen-list"
          aria-activedescendant={results[at] ? `files-quickopen-${at}` : undefined}
          placeholder={QUICK_TEXT.placeholder} value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown}
        />
        <div id="files-quickopen-list" role="listbox" className="max-h-[300px] overflow-y-auto">
          {loaded === null && <div role="status">{QUICK_TEXT.loading}</div>}
          {loaded && 'error' in loaded && <div role="alert">{QUICK_TEXT.failed + loaded.error}</div>}
          {files && results.length === 0 && <div role="status">{QUICK_TEXT.none}</div>}
          {results.map((rel, i) => (
            <Button
              key={rel} id={`files-quickopen-${i}`} type="button" role="option" aria-selected={i === at}
              variant={i === at ? 'secondary' : 'ghost'} size="sm" className="w-full justify-start" title={rel}
              tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => { onOpen(rel); onClose() }}
            >
              {rel}
            </Button>
          ))}
          {loaded && 'truncated' in loaded && loaded.truncated && <div role="status">{QUICK_TEXT.truncated}</div>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
