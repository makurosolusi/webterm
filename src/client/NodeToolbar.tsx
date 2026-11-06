import { useState, type ReactNode } from 'react'
import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { cn } from '@/lib/utils'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'
import { useFitCount } from './nodeToolbar.overflow'

/** Ikon codicon 16px; kelas `codicon` dimuat shell (`wkr-vsc-shell-01`), di sini hanya namanya. */
const Codicon = ({ name }: { name: string }) => <span className={cn('codicon', `codicon-${name}`)} aria-hidden="true" />

export interface NodeToolbarProps {
  onRefresh: () => void
  searchOpen: boolean; onToggleSearch: () => void
  micActive?: boolean; onToggleMic?: () => void      // node dengan input teks saja — omit button if undefined
  commentsOpen: boolean; onToggleComments: () => void; commentCount?: number
  maximized: boolean; onToggleMaximize: () => void; maximizeDisabled?: boolean
  /** Tab mode: there is no canvas area to maximize into. */
  hideMaximize?: boolean
  onClose: () => void
  onStop?: () => void                                  // agent only, while it runs: kill the session, keep the node — omit if undefined
  onAiName?: () => void; aiNaming?: boolean            // agent only — omit button if undefined
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean  // agent only
  hideLinks?: boolean; onToggleHideLinks?: () => void  // context-capable agent only — omit if undefined
  /** Item khusus tipe node (mis. Import Cookies di browser), di bawah separator di menu More Actions. */
  extraMenuItems?: VscodeMenuItem[]
  /** Lowest-priority inline action (the resize toggle), with the menu row that replaces it when it overflows. */
  extraAction?: { node: ReactNode; menuItem: VscodeMenuItem }
}

/**
 * Toolbar aksi node di header, memakai `vscode-toolbar-container`/`vscode-toolbar-button`.
 *
 * Seperti title bar editor VS Code, hanya aksi primer yang tampil (Search, Maximize, Close) dan
 * sisanya masuk menu "More Actions…" (`VscodeMenu`; aksi yang punya status tampil sebagai item
 * `checked`). Delapan ikon sejajar sebelumnya menumpuk dan tak berlabel.
 *
 * `toggleable` + `checked` pada tombol primer: status aktif milik komponen (latar
 * `--vscode-inputOption-activeBackground`) dan terbaca sebagai `aria-checked`. `label` mengisi
 * `aria-label` tombol di dalam shadow DOM; `title` dipertahankan di host karena tooltip bawaan
 * browser dan query test memakai atribut itu.
 *
 * Kelas `nodrag` di container: React Flow mencocokkannya lewat `target.closest()`, jadi satu kelas di
 * sini cukup untuk semua tombol — tanpa itu klik tombol ikut menggeser node.
 *
 * Maximize mengisi area canvas (VS Code "Maximize Editor Group"), tak pernah layar OS; satu-satunya tombol layout.
 * Urutan: aksi layout, "…", separator, Stop (merah `--vscode-debugIcon-stopForeground`, hanya saat agent jalan),
 * Close — aksi destruktif tak menempel ke aksi layout, dan tiap ikonnya beda (`nodeHeaderIconPolicy.test.tsx`).
 *
 * Header sempit: Search, Maximize dan `extraAction` (urut prioritas) ada di satu grup yang terpotong;
 * yang tak muat disembunyikan dan pindah ke atas menu "…" (`nodeToolbar.overflow`). "…", Stop dan Close
 * tak pernah ikut hilang.
 *
 * `maximizeDisabled` memberi `aria-disabled` di host; `vscode-toolbar-button` v2.4.0 tidak punya
 * properti `disabled`, jadi CSS yang mematikan pointer dan penjaga di handler yang menahan aksinya.
 */
export default function NodeToolbar(props: NodeToolbarProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const count = props.commentCount ?? 0
  const aiBusy = Boolean(props.aiNaming)
  const broadcastOff = Boolean(props.broadcastDisabled)
  const maximizeOff = Boolean(props.maximizeDisabled)
  const maxLabel = props.maximized ? 'Restore' : 'Maximize'
  const [groupRef, fit] = useFitCount()

  // Inline actions in priority order: the ones past `fit` overflow into the menu.
  const inline: { key: string; node: ReactNode; menuItem: VscodeMenuItem }[] = [
    {
      key: 'search',
      node: (
        <ToolbarButton
          label="Search" title="Search" data-title="Search"
          toggleable checked={props.searchOpen}
          onClick={props.onToggleSearch}
        ><Codicon name="search" /></ToolbarButton>
      ),
      menuItem: { type: 'item', id: 'search', label: 'Search', checked: props.searchOpen, onSelect: props.onToggleSearch },
    },
    ...(props.hideMaximize ? [] : [{
      key: 'maximize',
      node: (
        <ToolbarButton
          label={maxLabel} title={maxLabel} data-title={maxLabel}
          aria-disabled={maximizeOff || undefined}
          onClick={() => { if (!maximizeOff) props.onToggleMaximize() }}
        ><Codicon name={props.maximized ? 'screen-normal' : 'screen-full'} /></ToolbarButton>
      ),
      menuItem: { type: 'item', id: 'maximize', label: maxLabel, disabled: maximizeOff, onSelect: props.onToggleMaximize } as const,
    }]),
    ...(props.extraAction ? [{ key: 'extra', ...props.extraAction }] : []),
  ]
  const overflow = inline.slice(fit).map((a) => a.menuItem)

  const moreItems: VscodeMenuItem[] = [
    ...(overflow.length ? [...overflow, { type: 'separator' } as const] : []),
    { type: 'item', id: 'refresh', label: 'Refresh view', onSelect: props.onRefresh },
    ...(props.onToggleMic
      ? [{ type: 'item', id: 'mic', label: 'Dictate', checked: Boolean(props.micActive), onSelect: props.onToggleMic } as const]
      : []),
    ...(props.onAiName
      ? [{ type: 'item', id: 'ai-name', label: 'Name with AI', disabled: aiBusy, onSelect: props.onAiName } as const]
      : []),
    { type: 'item', id: 'comments', label: count > 0 ? `Comments (${count})` : 'Comments', checked: props.commentsOpen, onSelect: props.onToggleComments },
    ...(props.onBroadcast
      ? [{ type: 'item', id: 'broadcast', label: 'Share live view', checked: Boolean(props.broadcastActive), disabled: broadcastOff, onSelect: props.onBroadcast } as const]
      : []),
    ...(props.onToggleHideLinks
      ? [{ type: 'item', id: 'links', label: props.hideLinks ? 'Show links' : 'Hide links', onSelect: props.onToggleHideLinks } as const]
      : []),
    ...(props.extraMenuItems?.length ? [{ type: 'separator' } as const, ...props.extraMenuItems] : []),
  ]

  return (
    <>
      <ToolbarContainer className="nodrag node-toolbar">
        <div ref={groupRef} className="node-toolbar__overflow">
          {inline.map((a, i) => (
            <span key={a.key} className="node-toolbar__item" data-overflow={i >= fit || undefined}>{a.node}</span>
          ))}
        </div>

        <ToolbarButton
          label="More Actions…" title="More Actions…" data-title="More Actions…"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.left, y: r.bottom })
          }}
        ><Codicon name="ellipsis" /></ToolbarButton>

        <span className="node-toolbar__separator" role="separator" aria-orientation="vertical" />

        {props.onStop && (
          <ToolbarButton
            className="node-toolbar__stop"
            label="Stop Agent (keeps the node)" title="Stop Agent (keeps the node)" data-title="Stop Agent (keeps the node)"
            onClick={props.onStop}
          ><Codicon name="debug-stop" /></ToolbarButton>
        )}

        <ToolbarButton
          label="Close (ends the session)" title="Close (ends the session)" data-title="Close (ends the session)"
          onClick={props.onClose}
        ><Codicon name="close" /></ToolbarButton>
      </ToolbarContainer>
      {menuAt && <VscodeMenu open anchor={menuAt} items={moreItems} onClose={() => setMenuAt(null)} ariaLabel="More Actions" />}
    </>
  )
}
