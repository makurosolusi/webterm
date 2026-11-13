// The one labelled status chip in an agent node header (Claude Code extension: "Thinking…", "Waiting
// for approval"; VS Code: one decoration per tab). Words and tone come from the shared session status
// model, so the header, the tab strip and the Sessions side bar never disagree.
import { IconTooltip } from '@/components/ui/icon-button'
import type { AgentStatus } from '../shared/workspace'
import { sessionStatusView, type StatusInput, type StatusView } from './sessionStatus.model'
import { useNodeStatusFacts, useStatusNow } from './nodeStatus.store'
import { getActivity } from './nodeActivity.store'
import { getStatusReason } from './ws.listeners'

/** Chip of an already computed view; the reason sentence ("Waiting for approval: Bash") is its tooltip. */
export function NodeStatusChip({ view }: { view: StatusView }) {
  const spin = view.icon === 'loading' ? ' codicon-modifier-spin' : ''
  return (
    <IconTooltip label={view.label}>
      <span
        className={`node-status node-status--${view.tone}`} data-bucket={view.bucket}
        role="status" tabIndex={0} aria-label={`Status: ${view.label}`}
      >
        {view.icon && <span className={`codicon codicon-${view.icon}${spin}`} aria-hidden="true" />}
        {view.chip}
      </span>
    </IconTooltip>
  )
}

/** Inputs of the agent header chip: hook status + reason, the exit this page or the server saw, and "starting". */
export function agentStatusInput(o: {
  status?: AgentStatus
  reason?: { reason: StatusInput['reason']; detail?: string }
  exit?: { code: number }
  lastOutputAt?: number
  /** When the current launch was sent; output older than this belongs to the previous process. */
  openedAt: number
  since?: number
}): StatusInput {
  return {
    status: o.status,
    ...(o.reason ? { reason: o.reason.reason, ...(o.reason.detail ? { detail: o.reason.detail } : {}) } : {}),
    ...(o.exit ? { exit: o.exit } : {}),
    starting: (o.lastOutputAt ?? -Infinity) < o.openedAt,
    ...(o.since !== undefined ? { since: o.since } : {}),
  }
}

/**
 * Live chip of agent node `id`. It ticks with the shared 1s status clock to notice the first output,
 * so it lives in its own component: the node around it does not re-render every second.
 */
export function AgentStatusChip({ id, status, openedAt }: { id: string; status?: AgentStatus; openedAt: number }) {
  const info = useNodeStatusFacts(id, true)
  useStatusNow()
  const a = getActivity(id)
  const exit = a?.exit ?? (info && !info.live && info.exit && info.exit.at >= openedAt ? info.exit : undefined)
  const view = sessionStatusView(agentStatusInput({
    status, reason: getStatusReason(id), exit, lastOutputAt: a?.lastOutputAt, openedAt, since: info?.statusSince,
  }))
  return <NodeStatusChip view={view} />
}
