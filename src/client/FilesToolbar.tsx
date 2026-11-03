// Bilah kecil di bawah header node files: toggle tampilan dotfile, menu urutan, dan toolbar dari slot.
// Opsi dipersist lewat `viewOpts` (dipegang FilesNode); komponen ini hanya melaporkan perubahan.
import { useState } from 'react'
import type { ViewOpts } from '../shared/workspace'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'
import { FILES_SLOTS, type FilesSlotCtx } from './filesSlots'

interface Props {
  view: ViewOpts
  onChange: (next: ViewOpts) => void
  ctx: FilesSlotCtx
}

const KEYS: { key: ViewOpts['sortKey']; label: string }[] = [
  { key: 'name', label: 'Sort by Name' },
  { key: 'size', label: 'Sort by Size' },
  { key: 'mtime', label: 'Sort by Modified' },
]

export default function FilesToolbar({ view, onChange, ctx }: Props) {
  const [sortAt, setSortAt] = useState<{ x: number; y: number } | null>(null)
  const items: VscodeMenuItem[] = [
    ...KEYS.map(({ key, label }): VscodeMenuItem => ({
      type: 'item', id: key, label, checked: view.sortKey === key, onSelect: () => onChange({ ...view, sortKey: key }),
    })),
    { type: 'separator' },
    { type: 'item', id: 'asc', label: 'Ascending', checked: view.sortDir === 'asc', onSelect: () => onChange({ ...view, sortDir: 'asc' }) },
    { type: 'item', id: 'desc', label: 'Descending', checked: view.sortDir === 'desc', onSelect: () => onChange({ ...view, sortDir: 'desc' }) },
  ]
  return (
    <div className="files-toolbar nodrag">
      <button
        type="button" className="files-tool" aria-pressed={view.hidden}
        title={view.hidden ? 'Show hidden files' : 'Hide hidden files'}
        aria-label="Hide hidden files"
        onClick={() => onChange({ ...view, hidden: !view.hidden })}
      >
        <span className={`codicon codicon-${view.hidden ? 'eye-closed' : 'eye'}`} aria-hidden="true" />
      </button>
      <button
        type="button" className="files-tool" title="Sort" aria-label="Sort" aria-haspopup="menu"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSortAt({ x: r.left, y: r.bottom }) }}
      >
        <span className="codicon codicon-list-ordered" aria-hidden="true" />
      </button>
      {FILES_SLOTS.map((s) => {
        const node = s.toolbar?.(ctx)
        return node ? <span key={s.id} className="files-slot-tool">{node}</span> : null
      })}
      {sortAt && <VscodeMenu open anchor={sortAt} items={items} onClose={() => setSortAt(null)} ariaLabel="Sort files" />}
    </div>
  )
}
