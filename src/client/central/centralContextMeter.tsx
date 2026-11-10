// The Central chat header's context meter: how full this conversation's context is. Reloads after each settled
// turn and when the chat comes back into view; clicking shows the last compaction summary.
import { useEffect, useRef } from 'react'
import { Popover } from 'radix-ui'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { REJECT_RATIO, ROTATE_RATIO } from '../../server/central/context/rotationPolicy'
import { relativeTime } from '../SessionHistory.model'
import { useSideBar } from '../secondarySideBar.store'
import { compact } from './LevelPanel'
import { CL } from './centralLabels'
import { fetchCentralContext } from './centralControlApi'
import { useLiveRefresh, useLoad } from './centralLoad'
import './central.css'

const PERCENT = 100

/** Colour band of a fill percentage: the bands are the session rotation thresholds. */
export function contextLevel(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= REJECT_RATIO * PERCENT) return 'danger'
  return percent >= ROTATE_RATIO * PERCENT ? 'warn' : 'ok'
}

export interface CentralContextMeterProps {
  conversationId: string
  /** A new value reloads the meter (a turn settled). */
  refreshKey: number
  load?: typeof fetchCentralContext
}

/** Keyed on the conversation, so one chat's numbers never show on another. */
export function CentralContextMeter(props: CentralContextMeterProps) {
  return <Meter key={props.conversationId} {...props} />
}

function Meter({ conversationId, refreshKey, load = fetchCentralContext }: CentralContextMeterProps) {
  const context = useLoad((signal) => load(conversationId, signal))
  const seen = useRef(refreshKey)
  useEffect(() => {
    if (seen.current === refreshKey) return
    seen.current = refreshKey
    context.reload()
  }, [refreshKey, context.reload])
  const sideBar = useSideBar()
  useLiveRefresh(sideBar.open && sideBar.view === 'chat', context.reload)

  const data = context.data
  if (!data || data.tokens === null || data.percent === null) return null
  const compaction = data.lastCompaction
  const tooltip = `${CL.contextTooltip(compact(data.tokens), compact(data.window))}. ${compaction ? CL.contextCompacted(relativeTime(compaction.at)) : CL.contextNeverCompacted}`
  const text = CL.contextPercent(data.percent)
  return (
    <Popover.Root>
      <IconTooltip label={tooltip}>
        <Popover.Trigger asChild>
          <button type="button" className="ccm-meter" data-level={contextLevel(data.percent)} aria-label={`${text}. ${tooltip}`}>
            <span>{text}</span>
            <span className="ccm-bar" aria-hidden="true"><span className="ccm-bar__fill" style={{ width: `${Math.min(data.percent, PERCENT)}%` }} /></span>
          </button>
        </Popover.Trigger>
      </IconTooltip>
      <Popover.Portal container={portalContainer()}>
        <Popover.Content className="ccm-popover" side="bottom" align="end" sideOffset={4} aria-label={CL.contextSummaryHeading}>
          {!compaction && <p>{CL.contextNeverCompacted}</p>}
          {compaction && <p>{CL.contextCompacted(relativeTime(compaction.at))}</p>}
          {compaction && (compaction.summary ? <p className="ccm-popover__summary">{compaction.summary}</p> : <p>{CL.contextNoSummary}</p>)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
