import { useState } from 'react'
import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { cn } from '@/lib/utils'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'

/** Ikon codicon 16px; kelas `codicon` dimuat shell (`wkr-vsc-shell-01`), di sini hanya namanya. */
const Codicon = ({ name }: { name: string }) => <span className={cn('codicon', `codicon-${name}`)} aria-hidden="true" />

export interface NodeToolbarProps {
  onRefresh: () => void
  searchOpen: boolean; onToggleSearch: () => void
  micActive?: boolean; onToggleMic?: () => void      // node dengan input teks saja — omit button if undefined
  commentsOpen: boolean; onToggleComments: () => void; commentCount?: number
  maximized: boolean; onToggleMaximize: () => void; maximizeDisabled?: boolean
  fullscreen?: boolean; onToggleFullscreen?: () => void; fullscreenDisabled?: boolean  // omit onToggleFullscreen = no button
  onClose: () => void
  onStop?: () => void                                  // agent only: kill the session, keep the node — omit if undefined
  onAiName?: () => void; aiNaming?: boolean            // agent only — omit button if undefined
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean  // agent only
  hideLinks?: boolean; onToggleHideLinks?: () => void  // context-capable agent only — omit if undefined
  /** Item khusus tipe node (mis. Import Cookies di browser), di bawah separator di menu More Actions. */
  extraMenuItems?: VscodeMenuItem[]
}

/**
 * Toolbar aksi node di header, memakai `vscode-toolbar-container`/`vscode-toolbar-button`.
 *
 * Seperti title bar editor VS Code, hanya aksi primer yang tampil (Search, Maximize, Full Screen, Close) dan
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
 * Full Screen (Fullscreen API, menutupi seluruh layar) beda dari Maximize (`fitView` di dalam canvas); ikonnya
 * `chrome-maximize`/`chrome-restore` agar tak kembar dengan `screen-full`. Tombol hilang bila `onToggleFullscreen` kosong.
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
  const fsLabel = props.fullscreen ? 'Exit Full Screen' : 'Full Screen'
  const fsOff = Boolean(props.fullscreenDisabled)

  const moreItems: VscodeMenuItem[] = [
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
        <ToolbarButton
          label="Search" title="Search" data-title="Search"
          toggleable checked={props.searchOpen}
          onClick={props.onToggleSearch}
        ><Codicon name="search" /></ToolbarButton>

        <ToolbarButton
          label={maxLabel} title={maxLabel} data-title={maxLabel}
          aria-disabled={maximizeOff || undefined}
          onClick={() => { if (!maximizeOff) props.onToggleMaximize() }}
        ><Codicon name={props.maximized ? 'screen-normal' : 'screen-full'} /></ToolbarButton>

        {props.onToggleFullscreen && (
          <ToolbarButton
            label={fsLabel} title={fsLabel} data-title={fsLabel}
            aria-disabled={fsOff ? 'true' : undefined}
            onClick={() => { if (!fsOff) props.onToggleFullscreen?.() }}
          ><Codicon name={props.fullscreen ? 'chrome-restore' : 'chrome-maximize'} /></ToolbarButton>
        )}

        <ToolbarButton
          label="More Actions…" title="More Actions…" data-title="More Actions…"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.left, y: r.bottom })
          }}
        ><Codicon name="ellipsis" /></ToolbarButton>

        {props.onStop && (
          <ToolbarButton
            label="Stop agent" title="Stop agent (keeps the node)" data-title="Stop agent"
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
