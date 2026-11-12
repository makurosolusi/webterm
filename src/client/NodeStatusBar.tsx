// Status bar at the bottom of terminal and agent nodes (VS Code / JetBrains style): session and agent
// facts on the left, anomaly badges on the right. Hover or keyboard focus shows the full value; a click
// opens every field plus "Copy diagnostics". Settings › Canvas › Status bar turns it off.
import { useEffect, useRef, useState } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { VscodePopover } from './components/vscode/vscodePopover'
import { useLiveSettings } from './useSettings'
import { useConnection } from './useConnection'
import { getActivity } from './nodeActivity.store'
import { useNodeStatusFacts, useStatusNow } from './nodeStatus.store'
import { diagnosticsJson, statusBarModel, type StatusBarKind } from './nodeStatusBar.fields'
import type { Anomaly } from './nodeStatusBar.rules'
import { writeClipboard } from './clipboard'
import './node-statusbar.css'

export const STATUS_BAR_TEXT = {
  bar: 'Node status',
  copy: 'Copy diagnostics',
  copying: 'Copying…',
  copied: 'Diagnostics copied',
  noClipboard: 'The clipboard is not available here (it needs https or localhost).',
  warnings: (n: number) => `${n} ${n === 1 ? 'warning' : 'warnings'}`,
} as const

export interface NodeStatusBarProps {
  /** PTY session id: the node id, or the active pane of a split terminal. */
  sessionId: string
  kind: StatusBarKind
  cwd?: string
}

const ICON: Record<Anomaly['level'], string> = { warn: 'codicon-warning', error: 'codicon-error' }

/** The polite announcement changes only when the SET of anomalies changes, not with every age tick. */
function useAnnouncement(anomalies: Anomaly[]): string {
  const key = anomalies.map((a) => a.id).join(',')
  const [text, setText] = useState('')
  const latest = useRef(anomalies)
  latest.current = anomalies
  useEffect(() => { setText(latest.current.map((a) => a.reason).join(' ')) }, [key])
  return text
}

function Bar({ sessionId, kind, cwd }: NodeStatusBarProps): React.JSX.Element {
  const info = useNodeStatusFacts(sessionId, true)
  const now = useStatusNow()
  const connection = useConnection().phase
  const input = { kind, now, connection, activity: getActivity(sessionId), info, cwd }
  const model = statusBarModel(input)
  const announced = useAnnouncement(model.anomalies)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const copy = useAction(async () => {
    if (!(await writeClipboard(diagnosticsJson(sessionId, input, model)))) throw new Error(STATUS_BAR_TEXT.noClipboard)
  }, { label: STATUS_BAR_TEXT.copy, success: () => STATUS_BAR_TEXT.copied, failure: (e) => (e instanceof Error ? e.message : String(e)) })
  const toggle = () => setOpen((o) => !o)

  return (
    <footer ref={ref} className="node-statusbar nodrag" aria-label={STATUS_BAR_TEXT.bar} data-anomalies={model.anomalies.length || undefined}>
      <span className="node-statusbar__items">
        {model.items.map((it) => (
          <IconTooltip key={it.id} label={it.full} side="top">
            <button type="button" className="node-statusbar__item" data-item={it.id} onClick={toggle}>{it.text}</button>
          </IconTooltip>
        ))}
      </span>
      <span className="node-statusbar__badges">
        {model.anomalies.map((a) => (
          <IconTooltip key={a.id} label={a.reason} side="top">
            <button type="button" className="node-statusbar__badge" data-level={a.level} data-anomaly={a.id} onClick={toggle}>
              <span className={`codicon ${ICON[a.level]}`} aria-hidden="true" />
              <span className="node-statusbar__reason">{a.reason}</span>
            </button>
          </IconTooltip>
        ))}
      </span>
      <span className="sr-only" aria-live="polite" role="status">{announced}</span>
      {open && ref.current && (
        <VscodePopover anchor={ref.current} open onOpenChange={setOpen} placement="top" ariaLabel={STATUS_BAR_TEXT.bar} className="node-statusbar__pop">
          {model.anomalies.length > 0 && (
            <ul className="node-statusbar__pop-anomalies" aria-label={STATUS_BAR_TEXT.warnings(model.anomalies.length)}>
              {model.anomalies.map((a) => (
                <li key={a.id} data-level={a.level}><span className={`codicon ${ICON[a.level]}`} aria-hidden="true" /> {a.reason}</li>
              ))}
            </ul>
          )}
          <dl className="node-statusbar__pop-fields">
            {model.items.map((it) => (<div key={it.id}><dt>{it.id}</dt><dd>{it.full}</dd></div>))}
          </dl>
          <ActionButton action={copy} busyLabel={STATUS_BAR_TEXT.copying} size="sm" variant="secondary">{STATUS_BAR_TEXT.copy}</ActionButton>
          <ActionResult action={copy} />
        </VscodePopover>
      )}
    </footer>
  )
}

/** Renders nothing while Settings › Canvas › Status bar is off (`nodeStatusBar`). */
export default function NodeStatusBar(props: NodeStatusBarProps): React.JSX.Element | null {
  return useLiveSettings().nodeStatusBar ? <Bar {...props} /> : null
}
