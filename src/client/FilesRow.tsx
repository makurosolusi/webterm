// Satu baris listing node files. Dibungkus `memo`: props sengaja primitif supaya refresh daftar
// atau pindah kursor hanya merender ulang baris yang benar-benar berubah.
import { memo, type CSSProperties } from 'react'
import { TreeItem } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import { fileIconClass, fileIconTone, folderIconClass } from './fileIcon'
import type { Decoration, FilesSlot, FilesSlotCtx } from './filesSlots'
import { leafName } from './filesTree'

export interface FilesRowProps {
  /** `entry.name` is the path relative to cwd; only its last segment is shown. */
  entry: FileMeta
  index: number
  /** id DOM host; target `aria-activedescendant` pada list (satu model fokus). */
  domId: string
  selected: boolean
  /** Kursor (baris aktif). */
  cursor: boolean
  /** Nesting level (0 = directly in cwd): indent. */
  depth: number
  /** Expanded folder: chevron down + open folder icon. */
  open: boolean
  badge?: string
  decoTitle?: string
  decoClass?: string
}

/** Row icon classes: codicon glyph + `files-icon` + optional colour tone. */
export function iconClass(dir: boolean, open: boolean, leaf: string): string {
  if (dir) return `${folderIconClass(open)} files-icon`
  const tone = fileIconTone(leaf)
  return `${fileIconClass(leaf)} files-icon${tone ? ` files-icon--${tone}` : ''}`
}

export const FilesRow = memo(function FilesRow(p: FilesRowProps) {
  const { entry: e } = p
  const leaf = leafName(e.name)
  const cls = ['files-row files-row--compact', p.selected && 'files-row--sel', p.cursor && 'files-row--cursor', e.ignored && 'files-row--ignored', p.decoClass]
  return (
    <TreeItem
      ref={(el) => { if (el) { el.id = p.domId; if (e.dir) el.setAttribute('aria-expanded', String(p.open)); else el.removeAttribute('aria-expanded') } }}
      data-index={p.index} selected={p.selected} active={p.cursor}
    >
      <span data-index={p.index} className={cls.filter(Boolean).join(' ')} style={{ '--files-depth': p.depth } as CSSProperties}>
        <span className={`files-chevron${e.dir ? ` codicon codicon-chevron-${p.open ? 'down' : 'right'}` : ''}`} aria-hidden="true" />
        <span className={iconClass(e.dir, p.open, leaf)} aria-hidden="true" />
        <span className="files-name" title={e.name}>{leaf}</span>
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
