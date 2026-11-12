import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { AgentStatus, Comment } from '../shared/workspace'
import { Textfield, ToolbarButton } from '@/vscode/register'
import { cn } from '@/lib/utils'
import NodeColorSwatch from './NodeColorSwatch'
import NodeToolbar from './NodeToolbar'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import NodeComments from './NodeComments'
import { NodeResizeToggle, useNodeResizeMenuItem } from './nodeResize/NodeLayoutResizer'
import { useNodeHost } from './tabLayout.context'
import { useNodeMaximize } from './nodeMaximize.store'
import { NodeNameLabel } from './nodeName.label'

export interface NodeChromeProps {
  /** Editable label (title or kind fallback); Rename edits this, never `name`. */
  title: string
  /** Unique node name ("Mango"), shown first; absent until the board has named the node. */
  name?: string
  /** Nama codicon untuk ikon tipe node di depan judul (mis. 'terminal', 'hubot'); kosong = tanpa ikon. */
  icon?: string
  /** Teks redup setelah judul, seperti deskripsi tab editor (mis. cwd). */
  description?: string
  /** Title tooltip (e.g. a Files node's full path); a click on the title still renames. */
  titleHint?: string
  onRename: (t: string) => void
  collapsed: boolean; onToggleCollapse: () => void
  color: string; onColor: (c: string) => void
  status?: AgentStatus            // agent only
  pill?: ReactNode                // <UsagePill/> for agent; omit for terminal
  comments: Comment[]; onAddComment: (text: string) => void
  // toolbar passthrough (NodeChrome owns comments open-state internally):
  onRefresh: () => void
  searchOpen: boolean; onToggleSearch: () => void
  micActive?: boolean; onToggleMic?: () => void   // node tanpa input suara: tombol Dictate disembunyikan
  onClose: () => void
  onStop?: () => void             // agent only: Stop button in the toolbar
  /** Stable identity color (agent only): chip before the title, separate from the node color. */
  identityColor?: string
  onAiName?: () => void; aiNaming?: boolean
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean
  hideLinks?: boolean; onToggleHideLinks?: () => void
  extraHeader?: ReactNode         // Resume/Restart buttons for agent node (rendered just before toolbar)
  menuItems?: VscodeMenuItem[]    // item tambahan menu More Actions (⋯) khusus tipe node
}

/** Judul yang dipakai saat node belum punya nama — nodeterm merender `data.title || 'Untitled'`. */
export const UNTITLED = 'Untitled'

/**
 * Chip status di header, atau `null` kalau tidak ada yang perlu dikatakan.
 *
 * Aturan "kapan chip muncul" diambil dari nodeterm `src/renderer/nodes/TerminalNode.tsx`: state
 * idle/selesai TIDAK merender chip apa pun (nodeterm tidak punya chip `DONE`). Labelnya literal di
 * markup, bukan hasil `text-transform`, karena di nodeterm tidak semua label huruf besar (chip
 * `unread` huruf kecil).
 *
 * `waiting` dan `blocked` DIPISAH di sini — nodeterm melipat keduanya ke satu NEEDS YOU, dan
 * lipatan itulah bug yang dilaporkan: sebuah node memasang NEEDS YOU setelah agent-nya cuma
 * menyelesaikan turn, lalu pembacanya tidak menemukan permintaan apa pun di percakapan. Chip yang
 * berteriak palsu berhenti dipercaya, dan dengan itu chip yang berteriak BENAR ikut mati nilainya.
 * Perbedaannya sudah ada di kawat (`hookStatus`: `PermissionRequest`/`permission_prompt` →
 * `blocked`, akhir turn → `waiting`); UI-lah yang membuangnya.
 *
 * Tiga sumbu beda sekaligus, karena chip sebesar ini harus terbaca dalam sekejap dan satu kata yang
 * berbeda saja tidak cukup:
 *  - KATA: "NEEDS YOU" (tuntutan) vs "TURN ENDED" (laporan).
 *  - WARNA: merah `--state-attention` vs amber `--state-warning` — pasangan token yang SUDAH
 *    dipakai repo ini untuk dua status itu di MiniMap (`canvasStyle.ts`) dan Kanban (`Kanban.tsx`).
 *  - GERAK: hanya `blocked` yang dot-nya berdenyut (lihat `node-chrome.css`). `blocked` satu-satunya
 *    status yang berarti kerja benar-benar MANDEG sampai pengguna bertindak, jadi ia yang dapat
 *    penanda terkuat; turn yang habis boleh diam.
 */
export function statusChip(status?: AgentStatus): { cls: string; label: string; title: string } | null {
  if (status === 'working') return { cls: 'node-status--busy', label: 'RUNNING', title: 'Agent is working' }
  if (status === 'blocked')
    return { cls: 'node-status--attention', label: 'NEEDS YOU', title: 'Blocked — waiting for your approval' }
  if (status === 'waiting')
    return { cls: 'node-status--waiting', label: 'TURN ENDED', title: 'Turn ended — nothing is blocked' }
  if (status === 'failed') return { cls: 'node-status--failed', label: 'FAILED', title: 'The agent failed to start or exited with an error' }
  if (status === 'stopped') return { cls: 'node-status--stopped', label: 'STOPPED', title: 'Stopped — Resume continues the session' }
  return null
}

/**
 * className untuk elemen `.term-node`.
 *
 * `working`/`attention` sengaja TANPA prefiks: glow node digantung pada
 * `.react-flow__node:has(.term-node.working)::after` (dan padanannya `[data-tab-node]` di tab; pseudo-nya harus hidup di luar `.term-node`
 * yang `overflow: hidden`), dan selector itu disalin apa adanya dari nodeterm.
 *
 * `waiting` dapat kelasnya SENDIRI, dengan alasan yang sama dengan pecahnya chip di atas: halo
 * merah berdenyut di sekeliling seluruh node adalah penanda terkencang yang dimiliki canvas ini,
 * dan memakainya untuk turn yang cuma habis akan membatalkan chip amber yang baru saja dipasang di
 * atasnya. `attention` (merah, berdenyut) tinggal milik `blocked`.
 */
export function termNodeClass(o: { selected?: boolean; collapsed?: boolean; status?: AgentStatus }): string {
  return (
    'term-node' +
    (o.selected ? ' term-node--selected' : '') +
    (o.collapsed ? ' term-node--collapsed' : '') +
    (o.status === 'working' ? ' working' : '') +
    (o.status === 'waiting' ? ' waiting' : '') +
    (o.status === 'blocked' ? ' attention' : '')
  )
}

/** Header elements that own their clicks, so a double-click on them is not Maximize. */
const HEADER_CONTROLS = '.nodrag, button, a, input, [role="button"], [role="menu"]'

export default function NodeChrome(props: NodeChromeProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [commentsOpen, setCommentsOpen] = useState(false)
  const titleRef = useRef<HTMLElement | null>(null)
  // Tab mode is view-only: collapse/resize/maximize would rewrite the node's canvas layout. A
  // maximized node keeps its canvas layout too, so collapse/resize hide there as well.
  const { inTab } = useNodeHost()
  const max = useNodeMaximize()
  const fixedLayout = inTab || max.maximized
  const resizeMenuItem = useNodeResizeMenuItem()
  // Double-click on the bare header toggles Maximize (VS Code: double-click the editor tab bar).
  // Controls are excluded; so is the title (`nodrag`), whose single click is Rename.
  const onHeaderDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (max.toggle && !(e.target as Element).closest(HEADER_CONTROLS)) max.toggle()
  }

  const beginEdit = () => { setDraft(props.title); setEditing(true) }
  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next) props.onRename(next)
  }
  // `delegatesFocus` di vscode-textfield membuat fokus host diteruskan ke input di shadow DOM.
  useEffect(() => {
    if (editing) titleRef.current?.focus()
  }, [editing])
  const onTitleKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
  }

  const chip = statusChip(props.status)

  return (
    <div className="node-header relative" onDoubleClick={onHeaderDoubleClick}>
      {!fixedLayout && (
        <ToolbarButton
          label={props.collapsed ? 'Expand' : 'Collapse'}
          className="nodrag"
          title={props.collapsed ? 'Expand' : 'Collapse'}
          data-title={props.collapsed ? 'Expand' : 'Collapse'}
          onClick={props.onToggleCollapse}
        ><span className={cn('codicon', props.collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down')} /></ToolbarButton>
      )}

      <NodeColorSwatch color={props.color} onColor={props.onColor} />

      {props.icon && <span className={cn('node-icon codicon', `codicon-${props.icon}`)} aria-hidden="true" />}

      {props.identityColor && (
        <span
          className="node-identity" aria-hidden="true"
          style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: props.identityColor }}
        />
      )}

      {editing ? (
        <Textfield
          ref={(node) => { titleRef.current = node }}
          className="nodrag node-title--edit" value={draft}
          // `input` adalah event yang diteruskan wrapper; `target` sudah di-retarget ke host,
          // yang menyimpan properti `value` milik vscode-textfield.
          onInput={(e) => setDraft((e.target as unknown as { value: string }).value)}
          onKeyDown={onTitleKey} onBlur={commit}
        />
      ) : (
        <span className="nodrag node-title" title={props.titleHint ? `${props.titleHint}\nClick to rename` : 'Rename'} onClick={beginEdit}>
          <NodeNameLabel name={props.name} label={props.name ? props.title : props.title || UNTITLED} />
        </span>
      )}

      {props.description && !editing && (
        <span className="node-description" title={props.description}>{props.description}</span>
      )}

      {chip && (
        <span className={cn('node-status', chip.cls)} title={chip.title}>
          <span className="node-status-dot" />
          {chip.label}
        </span>
      )}

      {props.pill}
      {props.extraHeader}

      <NodeToolbar
        onRefresh={props.onRefresh}
        searchOpen={props.searchOpen} onToggleSearch={props.onToggleSearch}
        micActive={props.micActive} onToggleMic={props.onToggleMic}
        commentsOpen={commentsOpen} onToggleComments={() => setCommentsOpen((o) => !o)} commentCount={props.comments.length}
        maximized={max.maximized} onToggleMaximize={() => max.toggle?.()} hideMaximize={!max.toggle}
        onClose={props.onClose}
        onStop={props.onStop}
        onAiName={props.onAiName} aiNaming={props.aiNaming}
        onBroadcast={props.onBroadcast} broadcastActive={props.broadcastActive} broadcastDisabled={props.broadcastDisabled}
        hideLinks={props.hideLinks} onToggleHideLinks={props.onToggleHideLinks}
        extraMenuItems={props.menuItems}
        extraAction={!props.collapsed && !fixedLayout ? { node: <NodeResizeToggle />, menuItem: resizeMenuItem } : undefined}
      />

      {commentsOpen && (
        <NodeComments
          comments={props.comments}
          onAdd={props.onAddComment}
          onClose={() => setCommentsOpen(false)}
        />
      )}
    </div>
  )
}
