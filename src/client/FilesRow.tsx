// Satu baris listing node files. Dibungkus `memo`: props sengaja primitif supaya refresh daftar
// atau pindah kursor hanya merender ulang baris yang benar-benar berubah.
import { memo } from 'react'
import { TreeItem } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import { fileIconClass, folderIconClass } from './fileIcon'
import type { Decoration, FilesSlot, FilesSlotCtx } from './filesSlots'

export interface FilesRowProps {
  entry: FileMeta
  index: number
  /** id DOM host; target `aria-activedescendant` pada list (satu model fokus). */
  domId: string
  selected: boolean
  /** Kursor (baris aktif). Folder pada kursor memakai ikon folder terbuka. */
  cursor: boolean
  badge?: string
  decoTitle?: string
  decoClass?: string
}

export const FilesRow = memo(function FilesRow(p: FilesRowProps) {
  const { entry: e } = p
  const cls = ['files-row', p.selected && 'files-row--sel', p.cursor && 'files-row--cursor', e.ignored && 'files-row--ignored', p.decoClass]
  return (
    <TreeItem ref={(el) => { if (el) el.id = p.domId }} data-index={p.index} selected={p.selected} active={p.cursor}>
      <span data-index={p.index} className={cls.filter(Boolean).join(' ')}>
        <span className={`${e.dir ? folderIconClass(p.cursor) : fileIconClass(e.name)} files-icon`} aria-hidden="true" />
        <span className="files-name" title={e.name}>{e.name}</span>
        {p.badge && <span className="files-badge" title={p.decoTitle}>{p.badge}</span>}
      </span>
    </TreeItem>
  )
})

/** Gabungkan dekorasi dari semua slot untuk satu entri: badge/title pertama menang, className digabung. */
export function decorateEntry(slots: readonly FilesSlot[], entry: FileMeta, ctx: FilesSlotCtx): Decoration {
  const out: Decoration = {}
  for (const s of slots) {
    const d = s.decorate?.(entry, ctx)
    if (!d) continue
    out.badge ??= d.badge
    out.title ??= d.title
    if (d.className) out.className = out.className ? `${out.className} ${d.className}` : d.className
  }
  return out
}
