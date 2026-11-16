// Baris sesi sidebar kiri sebagai simpul VS Code tree (`TreeItem`): sesi hidup dan baris "Recently
// closed". Header grupnya hidup di `./SessionGroupItem`. Yang tinggal di sini hanya BENTUK baris:
// ikon kind, judul, deskripsi, glyph status (dari model bersama), waktu, dan aksi hover. Apa yang
// baris itu KATAKAN diputuskan di `./sessionList.row` (bebas DOM, dites di node-env).
import { useEffect, useRef } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { TreeItem } from './vscode/register'
import { KIND_ICON } from './nodeList'
import { relativeTime } from './SessionHistory.model'
import { SessionStatusGlyph } from './SessionStatusGlyph'
import { sessionLabel, type SessionRowVM } from './sessionList'
import { rowAge, rowDescription, rowTooltip } from './sessionList.row'
import type { ClosedEntry } from './closedHistory'

interface InlineActionProps {
  icon: string
  tooltip: string
  ariaLabel: string
  className: string
  /** Gets the button, so a menu can anchor to it. */
  onActivate: (el: HTMLElement) => void
}

/**
 * Inline action in the tree item's `slot="actions"` (shown on hover/focus by the library).
 *
 * Tree item memasang handler klik di shadow root-nya untuk seleksi, dan handler itu memanggil
 * `stopPropagation()`. Akibatnya klik pada tombol ini tidak pernah sampai ke root React (delegasi
 * event React berhenti di shadow boundary). Jadi listener dipasang NATIF di elemen tombol: ia
 * berjalan lebih dulu, menghentikan bubble ke wrapper, dan hanya memanggil aksi barisnya.
 * Enter/Space juga ditangkap di sini: `vscode-tree` mem-preventDefault keduanya di host, jadi
 * tanpa ini keyboard memilih/melipat barisnya alih-alih menekan tombol.
 */
export function InlineAction({ icon, tooltip, ariaLabel, className, onActivate }: InlineActionProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const run = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      onActivateRef.current(el)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') run(e)
    }
    el.addEventListener('click', run)
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('click', run)
      el.removeEventListener('keydown', onKey)
    }
  }, [])
  return (
    <IconTooltip label={tooltip}>
      <button ref={ref} type="button" slot="actions" className={`ss-tree__action ${className}`} aria-label={ariaLabel}>
        <span className={`codicon codicon-${icon}`} aria-hidden />
      </button>
    </IconTooltip>
  )
}

/** Target aksi sebuah simpul pohon. Panel memetakan elemen → target lewat ref supaya klik/Enter
 *  dari shadow tree tetap bisa memanggil callback React tanpa bergantung pada atribut DOM. */
export type TreeTarget =
  | { kind: 'session'; id: string; path?: string; renamable?: boolean }
  | { kind: 'node'; id: string; path?: string }
  | { kind: 'reopen'; id: string; path?: string }
  | { kind: 'group'; key: string; projectId?: string; isActive?: boolean }

export type RegisterTreeTarget = (el: Element | null, target: TreeTarget) => void

/** Anchor of a menu opened from a row's ⋯ action: just below the button. */
const below = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.bottom }
}

export interface SessionTreeItemProps {
  row: SessionRowVM
  /** Project tab: under its workspace header. Status tab: mixed boards under a bucket header,
   *  which already shows the status icon, so the row only keeps the unread mark. */
  mode: 'project' | 'status'
  /** The group's folder (Project tab): the row repeats its own folder only when it differs. */
  groupCwd?: string
  /** Shared 1s clock (`useStatusNow`) the relative time is read against. */
  now: number
  onCloseSession: (id: string) => void
  /** Absent = this row cannot be renamed here (its board is not the open one). */
  onRename?: (row: SessionRowVM) => void
  onMoreActions: (target: TreeTarget, anchor: { x: number; y: number }) => void
  register: RegisterTreeTarget
}

/** Satu baris sesi (leaf). Ikon kind duduk di slot ikon leaf milik tree — kolom yang sama dengan
 *  glyph VS Code, jadi indentasi dan tinggi baris 22px datang dari library, bukan dari kita. */
export function SessionTreeItem({ row, mode, groupCwd, now, onCloseSession, onRename, onMoreActions, register }: SessionTreeItemProps) {
  const description = rowDescription(row, mode, groupCwd)
  const age = rowAge(row.view.since, now)
  const showGlyph = mode === 'project' || row.view.unread
  const target: TreeTarget = { kind: 'session', id: row.id, path: row.cwd, renamable: !!onRename }
  const closeRef = useRef(onCloseSession)
  closeRef.current = onCloseSession

  // Klik tengah menutup sesi: kebiasaan tab browser. Dipasang natif
  // di host (bukan `onAuxClick` React) karena satu file ini sudah hidup di dua sisi shadow boundary
  // yang berbeda; listener host pasti menerima bubble dari isi yang di-slotted.
  const registerRow = (el: HTMLElement | null) => {
    register(el, target)
    if (!el) return
    const handler = (e: Event) => {
      const mouse = e as MouseEvent
      if (mouse.button !== 1) return
      mouse.preventDefault()
      closeRef.current(row.id)
    }
    el.addEventListener('auxclick', handler)
    return () => el.removeEventListener('auxclick', handler)
  }

  return (
    <TreeItem
      className={row.view.unread ? 'ss-tree__leaf ss-tree__leaf--unread' : 'ss-tree__leaf'}
      aria-label={`${row.label} — ${row.view.label}`}
      ref={registerRow}
    >
      {/* Ikon kind di slot ikon; warna sesi menempel di ikon (seperti warna terminal VS Code), label tetap netral. */}
      <span slot="icon-leaf" className="ss-tree__kind" style={row.color ? { color: row.color } : undefined} aria-hidden>
        <span className={`codicon codicon-${KIND_ICON[row.kind]}`} />
      </span>
      {/* The hover text sits on the label: `@lit/react` drops a `title` given to the tree item. */}
      <span className="ss-tree__label" title={rowTooltip(row, now)}>{row.label}</span>
      {description && (
        <span slot="description" className="ss-meta">
          {description}
        </span>
      )}
      <span slot="decoration" className="ss-tree__decoration">
        {showGlyph && <SessionStatusGlyph view={row.view} className="ss-glyph" />}
        {age && <span className="ss-age">{age}</span>}
      </span>
      {onRename && (
        <InlineAction icon="edit" tooltip="Rename" ariaLabel={`Rename ${row.label}`} className="ss-tree__rename" onActivate={() => onRename(row)} />
      )}
      <InlineAction icon="trash" tooltip="End session" ariaLabel={`End session ${row.label}`} className="ss-tree__end" onActivate={() => onCloseSession(row.id)} />
      <InlineAction icon="ellipsis" tooltip="More Actions…" ariaLabel={`More actions for ${row.label}`} className="ss-tree__more" onActivate={(el) => onMoreActions(target, below(el))} />
    </TreeItem>
  )
}

export interface ClosedTreeItemProps {
  entry: ClosedEntry
  now: number
  onRestore: (id: string) => void
  register: RegisterTreeTarget
}

/** One "Recently closed" row: kind icon, name, "workspace · 5m ago", inline Restore on hover. */
export function ClosedTreeItem({ entry, now, onRestore, register }: ClosedTreeItemProps) {
  const label = sessionLabel(entry.node)
  const when = relativeTime(entry.closedAt, now)
  return (
    <TreeItem
      className="ss-tree__leaf"
      aria-label={`Reopen ${label}`}
      ref={(el) => register(el, { kind: 'reopen', id: entry.node.id, path: entry.node.cwd })}
    >
      <span slot="icon-leaf" className="ss-tree__kind" aria-hidden>
        <span className={`codicon codicon-${KIND_ICON[entry.node.kind]}`} />
      </span>
      <span className="ss-tree__label" title={[label, entry.node.cwd, `Closed ${when}`].filter(Boolean).join(' — ')}>{label}</span>
      {/* Nama workspace SELALU ikut: daftar ini meruntuhkan dinding workspace, jadi tanpa itu
          barisnya tidak bilang akan muncul kembali di board mana. */}
      <span slot="description" className="ss-meta">
        {`${entry.workspaceName} · ${when}`}
      </span>
      <InlineAction icon="discard" tooltip="Restore" ariaLabel={`Restore ${label}`} className="ss-tree__restore" onActivate={() => onRestore(entry.node.id)} />
    </TreeItem>
  )
}
