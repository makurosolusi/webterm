type Svg = React.SVGProps<SVGSVGElement>
const svg = (children: React.ReactNode) => (p: Svg) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>{children}</svg>
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

export default function NodeToolbar(props: NodeToolbarProps) {
  const count = props.commentCount ?? 0
  return (
    // `nodrag` di container: React Flow mencocokkannya lewat `target.closest()`, jadi satu kelas di
    // sini cukup untuk semua tombol — tanpa itu klik tombol ikut menggeser node.
    <div className="nodrag node-toolbar">
      <button className="icon-btn" title="Refresh view" onClick={props.onRefresh}><IconRefresh /></button>

      <button
        className={`icon-btn${props.searchOpen ? ' icon-btn--active' : ''}`}
        title="Search" onClick={props.onToggleSearch}
      ><IconSearch /></button>

      {props.onToggleMic && (
        <button
          className={`icon-btn${props.micActive ? ' icon-btn--active' : ''}`}
          title="Dictate" onClick={props.onToggleMic}
        ><IconMic /></button>
      )}

      {props.onAiName && (
        <button className="icon-btn" title="Name with AI" onClick={props.onAiName} disabled={props.aiNaming}><IconSparkle /></button>
      )}

      <button
        className={`icon-btn${props.commentsOpen ? ' icon-btn--active' : ''}`}
        title="Comments" onClick={props.onToggleComments}
      >
        <IconComments />
        {count > 0 && <sup style={{ fontSize: 9, marginLeft: 2 }}>{count}</sup>}
      </button>

      {props.onBroadcast && (
        <button
          className={`icon-btn${props.broadcastActive ? ' icon-btn--active' : ''}`}
          title="Share live view" onClick={props.onBroadcast} disabled={props.broadcastDisabled}
        ><IconBroadcast /></button>
      )}

      {props.onToggleHideLinks && (
        <button
          className={`icon-btn${props.hideLinks ? ' icon-btn--active' : ''}`}
          title={props.hideLinks ? 'Show links' : 'Hide links'} onClick={props.onToggleHideLinks}
        >{props.hideLinks ? <IconEyeOff /> : <IconEye />}</button>
      )}

      <button className="icon-btn" title="Maximize" onClick={props.onToggleMaximize} disabled={props.maximizeDisabled}><IconMaximize /></button>

      <button className="icon-btn icon-btn--danger" title="Close (ends the session)" onClick={props.onClose}><IconClose /></button>
    </div>
  )
}
