import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { AgentStatus, Comment } from '../shared/workspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import NodeColorSwatch from './NodeColorSwatch'
import NodeToolbar from './NodeToolbar'
import NodeComments from './NodeComments'

export interface NodeChromeProps {
  title: string
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
  maximized: boolean; onToggleMaximize: () => void
  onClose: () => void
  onAiName?: () => void; aiNaming?: boolean
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean
  hideLinks?: boolean; onToggleHideLinks?: () => void
  extraHeader?: ReactNode         // Resume/Restart buttons for agent node (rendered just before toolbar)
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
  return null
}

/**
 * className untuk elemen `.term-node`.
 *
 * `working`/`attention` sengaja TANPA prefiks: glow node digantung pada
 * `.react-flow__node:has(.term-node.working)::after` (pseudo-nya harus hidup di luar `.term-node`
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

const IconChevron = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}
    className={cn('size-3.5', p.className)}><path d="M4 6l4 4 4-4" /></svg>
)

export default function NodeChrome(props: NodeChromeProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [commentsOpen, setCommentsOpen] = useState(false)

  const beginEdit = () => { setDraft(props.title); setEditing(true) }
  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next) props.onRename(next)
  }
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
  }

  const chip = statusChip(props.status)

  return (
    <div className="node-header" style={{ position: 'relative' }}>
      <Button
        variant="ghost" size="icon-xs"
        className={cn('nodrag icon-btn node-chevron', props.collapsed && 'node-chevron--collapsed')}
        title={props.collapsed ? 'Expand' : 'Collapse'}
        onClick={props.onToggleCollapse}
      ><IconChevron /></Button>

      <NodeColorSwatch color={props.color} onColor={props.onColor} />

      {editing ? (
        <Input
          className="nodrag node-title--edit" autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onTitleKey} onBlur={commit}
        />
      ) : (
        <span className="nodrag node-title" title="Rename" onClick={beginEdit}>{props.title || UNTITLED}</span>
      )}

      {chip && (
        <Badge
          className={cn('node-status rounded-none border-0 bg-transparent px-0 py-0', chip.cls)}
          title={chip.title}
        >
          <span className="node-status-dot" />
          {chip.label}
        </Badge>
      )}

      {props.pill}
      {props.extraHeader}

      <NodeToolbar
        onRefresh={props.onRefresh}
        searchOpen={props.searchOpen} onToggleSearch={props.onToggleSearch}
        micActive={props.micActive} onToggleMic={props.onToggleMic}
        commentsOpen={commentsOpen} onToggleComments={() => setCommentsOpen((o) => !o)} commentCount={props.comments.length}
        maximized={props.maximized} onToggleMaximize={props.onToggleMaximize}
        onClose={props.onClose}
        onAiName={props.onAiName} aiNaming={props.aiNaming}
        onBroadcast={props.onBroadcast} broadcastActive={props.broadcastActive} broadcastDisabled={props.broadcastDisabled}
        hideLinks={props.hideLinks} onToggleHideLinks={props.onToggleHideLinks}
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
