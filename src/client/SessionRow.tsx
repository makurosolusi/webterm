// Baris sesi sidebar kiri sebagai simpul VS Code tree (`TreeItem`), plus header grupnya.
// Dipisah dari `SessionsPanel` supaya kerangka panel (tab, filter, pohon) tetap terbaca dalam satu
// layar. Yang tinggal di sini hanya BENTUK baris: judulnya, glyph status, slot ikon, dan tombol
// akhiri sesi. Logika pengelompokan tetap di `./sessionList` (bebas DOM, dites di node-env).
import { useEffect, useRef, type ReactNode } from 'react'
import { TreeItem } from './vscode/register'
import { rowMeta, type SessionRowVM, type SignalCounts } from './sessionList'

/** Kalimat glyph belum-dibaca, dipakai juga sebagai bagian nama aksesibel barisnya. */
const UNREAD_TITLE = 'Finished — new for you'

/** Apakah baris ini memakai glyph belum-dibaca? Bel (giliranmu) dan turn yang sedang jalan
 *  MENGALAHKANNYA — prompt izin atau turn baru lebih mendesak daripada tanda lama; sama dengan
 *  prioritas `sessionStatusGroup`. Satu predikat karena dua pembaca (glyph dan aria-label). */
const showsUnread = (row: SessionRowVM): boolean =>
  row.unread === true && row.statusKind !== 'attention' && row.statusKind !== 'working'

/** Satu glyph status di slot decoration (kanan baris), seperti dekorasi terminal VS Code. Prioritas:
 *  bel (giliranmu) → centang belum-dibaca → centang (selesai) → spinner (jalan) → titik. Satu baris
 *  hanya punya satu slot, jadi sinyal yang paling menuntut tindakan yang menang. */
function StatusGlyph({ row }: { row: SessionRowVM }) {
  let icon = 'circle-small-filled'
  let tone: string = row.statusKind
  let title = row.stateLabel
  if (row.statusKind === 'attention') icon = 'bell'
  else if (showsUnread(row)) [icon, tone, title] = ['check', 'unread', UNREAD_TITLE]
  else if (row.statusKind === 'done') icon = 'check'
  else if (row.statusKind === 'working') icon = 'loading codicon-modifier-spin'
  return (
    <span slot="decoration" className={`ss-glyph ss-glyph--${tone}`} title={title}>
      <span className={`codicon codicon-${icon}`} aria-hidden />
    </span>
  )
}

/**
 * Tombol di dalam `slot="actions"` milik tree item.
 *
 * Tree item memasang handler klik di shadow root-nya untuk seleksi, dan handler itu memanggil
 * `stopPropagation()`. Akibatnya klik pada tombol ini tidak pernah sampai ke root React (delegasi
 * event React berhenti di shadow boundary). Jadi listener dipasang NATIF di elemen tombol: ia
 * berjalan lebih dulu, menghentikan bubble ke wrapper, dan hanya memanggil aksi barisnya.
 */
function EndSessionButton({ label, onEnd }: { label: string; onEnd: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handler = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      onEndRef.current()
    }
    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [])
  return (
    <button
      ref={ref}
      type="button"
      slot="actions"
      className="ss-tree__end"
      aria-label={`End session ${label}`}
      title="End session"
    >
      <span className="codicon codicon-trash" aria-hidden />
    </button>
  )
}

/** Target aksi sebuah simpul pohon. Panel memetakan elemen → target lewat ref supaya klik/Enter
 *  dari shadow tree tetap bisa memanggil callback React tanpa bergantung pada atribut DOM. */
export type TreeTarget =
  | { kind: 'session'; id: string; path?: string }
  | { kind: 'node'; id: string; path?: string }
  | { kind: 'reopen'; id: string; path?: string }
  | { kind: 'group'; key: string; projectId?: string; isActive?: boolean }

export type RegisterTreeTarget = (el: Element | null, target: TreeTarget) => void

export interface SessionTreeItemProps {
  row: SessionRowVM
  /** Tampilkan nama workspace di meta. Mode status meratakan semua workspace, jadi di sana
   *  nama itu satu-satunya petunjuk sesi ini milik siapa. */
  showProject: boolean
  onCloseSession: (id: string) => void
  register: RegisterTreeTarget
}

/** Satu baris sesi (leaf). Ikon status duduk di slot ikon leaf milik tree — kolom yang sama dengan
 *  glyph VS Code, jadi indentasi dan tinggi baris 22px datang dari library, bukan dari kita. */
export function SessionTreeItem({ row, showProject, onCloseSession, register }: SessionTreeItemProps) {
  const meta = rowMeta(showProject ? row.projectName : undefined, row.cwd)
  const aria = `${row.label} — ${row.stateLabel}${showsUnread(row) ? ` — ${UNREAD_TITLE}` : ''}`
  const closeRef = useRef(onCloseSession)
  closeRef.current = onCloseSession

  // Klik tengah menutup sesi: kebiasaan tab browser, dan nodeterm memakainya juga. Dipasang natif
  // di host (bukan `onAuxClick` React) karena satu file ini sudah hidup di dua sisi shadow boundary
  // yang berbeda; listener host pasti menerima bubble dari isi yang di-slotted.
  const registerRow = (el: HTMLElement | null) => {
    register(el, { kind: 'session', id: row.id, path: row.cwd })
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
      className="ss-tree__leaf"
      aria-label={aria}
      ref={registerRow}
    >
      {/* Ikon tipe di slot ikon; warna sesi menempel di ikon (seperti warna terminal VS Code), label tetap netral. */}
      <span slot="icon-leaf" className="ss-tree__kind" style={row.color ? { color: row.color } : undefined} aria-hidden>
        <span className={`codicon codicon-${row.isAgent ? 'hubot' : 'terminal'}`} />
      </span>
      <span className="ss-tree__label">{row.label}</span>
      {meta.length > 0 && (
        <span slot="description" className="ss-meta">
          {meta.join(' · ')}
        </span>
      )}
      <StatusGlyph row={row} />
      <EndSessionButton label={row.label} onEnd={() => onCloseSession(row.id)} />
    </TreeItem>
  )
}

export interface SessionGroupItemProps {
  /** Kunci lipatan yang dipersist panel (`collapsed`). */
  groupKey: string
  label: string
  count: number
  open: boolean
  register: RegisterTreeTarget
  /** Board yang sedang terbuka di canvas: hanya tab Project yang mengisinya. */
  isActive?: boolean
  projectId?: string
  /** Inisial workspace, menggantikan ikon kind. */
  monogram?: string
  color?: string
  /** Glyph untuk grup non-workspace (tab Status/Nodes). */
  icon?: ReactNode
  signals?: SignalCounts
  /**
   * Grup workspace membawa id board, sehingga kliknya bisa berpindah board. Header seksi
   * Status/Nodes tidak punya tujuan pindah — kliknya hanya melipat.
   */
  workspace?: boolean
  children: ReactNode
}

/** Header grup sebagai branch tree. Chevron, hover, dan tinggi 22px milik library; di sini hanya
 *  isi barisnya (label 11px uppercase, badge hitungan, monogram). */
export function SessionGroupItem(props: SessionGroupItemProps) {
  const {
    groupKey,
    label,
    count,
    open,
    register,
    isActive = false,
    projectId,
    monogram,
    color,
    icon,
    signals,
    workspace = false,
    children,
  } = props

  const iconSlots =
    monogram !== undefined ? (
      <>
        <span slot="icon-branch" className="ss-tree__monogram" style={color ? { background: color } : undefined} aria-hidden>
          {monogram}
        </span>
        <span
          slot="icon-branch-opened"
          className="ss-tree__monogram"
          style={color ? { background: color } : undefined}
          aria-hidden
        >
          {monogram}
        </span>
      </>
    ) : icon ? (
      <>
        <span slot="icon-branch" className="ss-tree__kind" aria-hidden>
          {icon}
        </span>
        <span slot="icon-branch-opened" className="ss-tree__kind" aria-hidden>
          {icon}
        </span>
      </>
    ) : null

  return (
    <TreeItem
      branch
      open={open}
      className={isActive ? 'ss-tree__group ss-tree__group--active' : 'ss-tree__group'}
      aria-current={isActive ? 'true' : undefined}
      data-group={groupKey}
      ref={(el) =>
        register(
          el,
          workspace
            ? { kind: 'group', key: groupKey, projectId, isActive }
            : { kind: 'group', key: groupKey },
        )
      }
    >
      {iconSlots}
      <span
        className={isActive ? 'ss-tree__group-label ss-tree__group-label--active' : 'ss-tree__group-label'}
      >
        {label}
      </span>
      <span slot="decoration" className="ss-tree__decoration">
        {signals && signals.attention > 0 && (
          <span className="ss-signal ss-signal--attention">{signals.attention}</span>
        )}
        {signals && signals.working > 0 && (
          <span className="ss-signal ss-signal--working">{signals.working}</span>
        )}
        <span className="ss-tree__count">{count}</span>
      </span>
      {children}
    </TreeItem>
  )
}
