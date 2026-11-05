// Output panel toolbar, VS Code order: channel dropdown, Log Level dropdown, filter box, then the
// icon actions (Clear Output, auto-scroll lock, Copy All, Save As, Close Panel).
import type { RefObject } from 'react'
import type { LogChannelInfo, LogLevel } from '../../shared/logEntry'
import { VscodeTooltip } from '../components/vscode/vscodeTooltip'

export const ALL_CHANNELS = 'all'
export const FILTER_PLACEHOLDER = 'Filter (e.g. text, !exclude, \\escape)'

/** Level choices in VS Code's "Set Log Level" order (there is no Off in the wire type). */
const LEVEL_OPTIONS: ReadonlyArray<{ value: LogLevel; label: string }> = [
  { value: 'trace', label: 'Trace' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
]

interface ActionButtonProps {
  label: string
  icon: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
}

function ActionButton({ label, icon, onClick, disabled, pressed }: ActionButtonProps): React.JSX.Element {
  return (
    <VscodeTooltip content={label}>
      <button type="button" className="vscode-panel-action" aria-label={label} disabled={disabled}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })} onClick={onClick}>
        <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      </button>
    </VscodeTooltip>
  )
}

export interface OutputToolbarProps {
  channels: LogChannelInfo[]
  channel: string
  onChannel: (channel: string) => void
  level: LogLevel
  onLevel: (level: LogLevel) => void
  filter: string
  onFilter: (filter: string) => void
  filterRef: RefObject<HTMLInputElement | null>
  autoScroll: boolean
  onToggleAutoScroll: () => void
  hasEntries: boolean
  onClear: () => void
  onCopy: () => void
  onSave: () => void
  onClose?: () => void
}

/** Toolbar row above the log. */
export function OutputToolbar(props: OutputToolbarProps): React.JSX.Element {
  const { channels, channel, filter } = props
  const known = channel === ALL_CHANNELS || channels.some((info) => info.channel === channel)
  return (
    <div className="output-toolbar" role="toolbar" aria-label="Output actions">
      <select className="output-select output-select--channel" aria-label="Output channel" title="Output channel"
        value={channel} onChange={(event) => props.onChannel(event.target.value)}>
        <option value={ALL_CHANNELS}>All</option>
        {!known && <option value={channel}>{channel} (0)</option>}
        {channels.map((info) => (
          <option key={info.channel} value={info.channel}>{info.channel} ({info.count})</option>
        ))}
      </select>
      <select className="output-select output-select--level" aria-label="Log Level" title="Set Log Level"
        value={props.level} onChange={(event) => props.onLevel(event.target.value as LogLevel)}>
        {LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <input ref={props.filterRef} type="text" className="output-filter" aria-label="Filter output"
        placeholder={FILTER_PLACEHOLDER} title={FILTER_PLACEHOLDER} spellCheck={false} autoComplete="off"
        value={filter} onChange={(event) => props.onFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && filter !== '') { event.stopPropagation(); props.onFilter('') }
        }} />
      <div className="output-toolbar__actions">
        <ActionButton label="Clear Output" icon="clear-all" onClick={props.onClear} />
        <ActionButton label={props.autoScroll ? 'Turn Auto Scrolling Off' : 'Turn Auto Scrolling On'}
          icon={props.autoScroll ? 'unlock' : 'lock'} pressed={!props.autoScroll} onClick={props.onToggleAutoScroll} />
        <ActionButton label="Copy All" icon="copy" disabled={!props.hasEntries} onClick={props.onCopy} />
        <ActionButton label="Save As..." icon="save" disabled={!props.hasEntries} onClick={props.onSave} />
        {props.onClose && <ActionButton label="Close Panel" icon="close" onClick={props.onClose} />}
      </div>
    </div>
  )
}
