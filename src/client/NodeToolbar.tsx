import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { cn } from '@/lib/utils'

type Svg = React.SVGProps<SVGSVGElement>
const svg = (children: React.ReactNode) => (p: Svg) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}
    className={cn('size-3.5', p.className)}>{children}</svg>
)

const IconRefresh = svg(<><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 3v2.5h-2.5" /></>)
const IconSearch = svg(<><circle cx="7" cy="7" r="3.5" /><path d="M10 10l3 3" /></>)
const IconMic = svg(<><rect x="6" y="2.5" width="4" height="7" rx="2" /><path d="M4 8a4 4 0 0 0 8 0" /><path d="M8 12v2" /></>)
const IconSparkle = svg(<path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3z" />)
const IconComments = svg(<path d="M3 4h10v6H7l-3 2.5V10H3z" />)
const IconBroadcast = svg(<><circle cx="8" cy="8" r="1.2" /><path d="M5 5a4 4 0 0 0 0 6M11 5a4 4 0 0 1 0 6" /></>)
const IconEye = svg(<><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></>)
const IconEyeOff = svg(<><path d="M3 3l10 10" /><path d="M6 4.3A6.6 6.6 0 0 1 8 4c4 0 6.5 4 6.5 4a12 12 0 0 1-2 2.4M4.2 5.6A12 12 0 0 0 1.5 8S4 12 8 12a6.7 6.7 0 0 0 2-.3" /></>)
const IconMaximize = svg(<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />)
const IconClose = svg(<path d="M4 4l8 8M12 4l-8 8" />)

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
  return (
    <ToolbarContainer className="nodrag node-toolbar">
      <ToolbarButton label="Refresh view" title="Refresh view" data-title="Refresh view" onClick={props.onRefresh}><IconRefresh /></ToolbarButton>

      <ToolbarButton
        label="Search" title="Search" data-title="Search"
        toggleable checked={props.searchOpen}
        onClick={props.onToggleSearch}
      ><IconSearch /></ToolbarButton>

      {props.onToggleMic && (
        <ToolbarButton
          label="Dictate" title="Dictate" data-title="Dictate"
          toggleable checked={Boolean(props.micActive)}
          onClick={props.onToggleMic}
        ><IconMic /></ToolbarButton>
      )}

      {props.onAiName && (
        <ToolbarButton
          label="Name with AI" title="Name with AI" data-title="Name with AI"
          aria-disabled={aiBusy || undefined}
          onClick={() => { if (!aiBusy) props.onAiName?.() }}
        ><IconSparkle /></ToolbarButton>
      )}

      <ToolbarButton
        label="Comments" title="Comments" data-title="Comments"
        toggleable checked={props.commentsOpen}
        onClick={props.onToggleComments}
      >
        <IconComments />
        {count > 0 && <sup className="node-toolbar__count">{count}</sup>}
      </ToolbarButton>

      {props.onBroadcast && (
        <ToolbarButton
          label="Share live view" title="Share live view" data-title="Share live view"
          toggleable checked={Boolean(props.broadcastActive)}
          aria-disabled={broadcastOff || undefined}
          onClick={() => { if (!broadcastOff) props.onBroadcast?.() }}
        ><IconBroadcast /></ToolbarButton>
      )}

      {props.onToggleHideLinks && (
        <ToolbarButton
          label={props.hideLinks ? 'Show links' : 'Hide links'}
          title={props.hideLinks ? 'Show links' : 'Hide links'}
          data-title={props.hideLinks ? 'Show links' : 'Hide links'}
          toggleable checked={Boolean(props.hideLinks)}
          onClick={props.onToggleHideLinks}
        >{props.hideLinks ? <IconEyeOff /> : <IconEye />}</ToolbarButton>
      )}

      <ToolbarButton
        label="Maximize" title="Maximize" data-title="Maximize"
        aria-disabled={maximizeOff || undefined}
        onClick={() => { if (!maximizeOff) props.onToggleMaximize() }}
      ><IconMaximize /></ToolbarButton>

      <ToolbarButton
        className="node-toolbar__danger"
        label="Close (ends the session)" title="Close (ends the session)" data-title="Close (ends the session)"
        onClick={props.onClose}
      ><IconClose /></ToolbarButton>
    </ToolbarContainer>
  )
}
