import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { cn } from '@/lib/utils'

/** Ikon codicon 16px; kelas `codicon` dimuat shell (`wkr-vsc-shell-01`), di sini hanya namanya. */
const Codicon = ({ name }: { name: string }) => <span className={cn('codicon', `codicon-${name}`)} aria-hidden="true" />

export interface NodeToolbarProps {
  onRefresh: () => void
  searchOpen: boolean; onToggleSearch: () => void
  micActive?: boolean; onToggleMic?: () => void      // node dengan input teks saja — omit button if undefined
  commentsOpen: boolean; onToggleComments: () => void; commentCount?: number
  maximized: boolean; onToggleMaximize: () => void; maximizeDisabled?: boolean
  onClose: () => void
  onAiName?: () => void; aiNaming?: boolean            // agent only — omit button if undefined
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean  // agent only
  hideLinks?: boolean; onToggleHideLinks?: () => void  // context-capable agent only — omit if undefined
}

/**
 * Toolbar aksi node di header, memakai `vscode-toolbar-container`/`vscode-toolbar-button`.
 *
 * `toggleable` + `checked` menggantikan kelas `icon-btn--active` lama: status aktif kini milik
 * komponen (latar `--vscode-inputOption-activeBackground`) dan ikut terbaca sebagai `aria-checked`.
 * `label` mengisi `aria-label` tombol di dalam shadow DOM; `title` dipertahankan di host karena
 * tooltip bawaan browser dan query test memakai atribut itu.
 *
 * Kelas `nodrag` di container: React Flow mencocokkannya lewat `target.closest()`, jadi satu kelas di
 * sini cukup untuk semua tombol — tanpa itu klik tombol ikut menggeser node.
 *
 * Tombol yang tidak boleh ditekan saat ini (`aiNaming`, `broadcastDisabled`, `maximizeDisabled`)
 * mendapat `aria-disabled` di host; `vscode-toolbar-button` v2.4.0 tidak punya properti `disabled`,
 * jadi CSS yang mematikan pointer dan penjaga di handler yang menahan aksinya.
 */
export default function NodeToolbar(props: NodeToolbarProps) {
  const count = props.commentCount ?? 0
  const aiBusy = Boolean(props.aiNaming)
  const broadcastOff = Boolean(props.broadcastDisabled)
  const maximizeOff = Boolean(props.maximizeDisabled)
  const maxLabel = props.maximized ? 'Restore' : 'Maximize'
  return (
    <ToolbarContainer className="nodrag node-toolbar">
      <ToolbarButton label="Refresh view" title="Refresh view" data-title="Refresh view" onClick={props.onRefresh}><Codicon name="refresh" /></ToolbarButton>

      <ToolbarButton
        label="Search" title="Search" data-title="Search"
        toggleable checked={props.searchOpen}
        onClick={props.onToggleSearch}
      ><Codicon name="search" /></ToolbarButton>

      {props.onToggleMic && (
        <ToolbarButton
          label="Dictate" title="Dictate" data-title="Dictate"
          toggleable checked={Boolean(props.micActive)}
          onClick={props.onToggleMic}
        ><Codicon name="mic" /></ToolbarButton>
      )}

      {props.onAiName && (
        <ToolbarButton
          label="Name with AI" title="Name with AI" data-title="Name with AI"
          aria-disabled={aiBusy || undefined}
          onClick={() => { if (!aiBusy) props.onAiName?.() }}
        ><Codicon name="sparkle" /></ToolbarButton>
      )}

      <ToolbarButton
        label="Comments" title="Comments" data-title="Comments"
        toggleable checked={props.commentsOpen}
        onClick={props.onToggleComments}
      >
        <Codicon name="comment" />
        {count > 0 && <sup className="node-toolbar__count">{count}</sup>}
      </ToolbarButton>

      {props.onBroadcast && (
        <ToolbarButton
          label="Share live view" title="Share live view" data-title="Share live view"
          toggleable checked={Boolean(props.broadcastActive)}
          aria-disabled={broadcastOff || undefined}
          onClick={() => { if (!broadcastOff) props.onBroadcast?.() }}
        ><Codicon name="broadcast" /></ToolbarButton>
      )}

      {props.onToggleHideLinks && (
        <ToolbarButton
          label={props.hideLinks ? 'Show links' : 'Hide links'}
          title={props.hideLinks ? 'Show links' : 'Hide links'}
          data-title={props.hideLinks ? 'Show links' : 'Hide links'}
          toggleable checked={Boolean(props.hideLinks)}
          onClick={props.onToggleHideLinks}
        ><Codicon name={props.hideLinks ? 'eye-closed' : 'eye'} /></ToolbarButton>
      )}

      <ToolbarButton
        label={maxLabel} title={maxLabel} data-title={maxLabel}
        aria-disabled={maximizeOff || undefined}
        onClick={() => { if (!maximizeOff) props.onToggleMaximize() }}
      ><Codicon name={props.maximized ? 'screen-normal' : 'screen-full'} /></ToolbarButton>

      <ToolbarButton
        label="Close (ends the session)" title="Close (ends the session)" data-title="Close (ends the session)"
        onClick={props.onClose}
      ><Codicon name="close" /></ToolbarButton>
    </ToolbarContainer>
  )
}
