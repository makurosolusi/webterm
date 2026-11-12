// Context window meter of the agent chat composer row (Claude Code VS Code context indicator).
import { IconTooltip } from '@/components/ui/icon-button'
import type { AgentChatContext } from '../../shared/agentChat.wire'
import './agentChatToolbar.css'

/** Share of the window (in %) from which the meter turns warning-coloured and suggests /compact. */
export const CONTEXT_WARN_PCT = 70
/** Share of the window (in %) from which the meter turns error-coloured. */
export const CONTEXT_DANGER_PCT = 90
const RING_RADIUS = 6
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

export type ContextLevel = 'ok' | 'warn' | 'danger'

/** Colour band of a usage percentage. */
export const contextLevel = (pct: number): ContextLevel =>
  pct >= CONTEXT_DANGER_PCT ? 'danger' : pct >= CONTEXT_WARN_PCT ? 'warn' : 'ok'

/** Ring + percentage of the context window used (`detail`: extra tooltip line); renders nothing without data. */
export function ContextMeter({ context, detail }: { context?: AgentChatContext; detail?: string }) {
  if (!context || context.window <= 0) return null
  const pct = Math.min(100, Math.max(0, Math.round((context.used / context.window) * 100)))
  const level = contextLevel(pct)
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hint = level === 'ok' ? '' : '. Run /compact to summarize the conversation and free space.'
  const tip = `${fmt(context.used)} of ${fmt(context.window)} tokens (${pct}%)${hint}${detail ? `. ${detail}` : ''}`
  return (
    <IconTooltip label={tip}>
      <span className={`act-meter act-meter--${level}`} role="meter" tabIndex={0} aria-label="Context window used"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={tip} data-level={level}>
        <svg className="act-meter__ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r={RING_RADIUS} className="act-meter__track" />
          <circle cx="8" cy="8" r={RING_RADIUS} className="act-meter__fill" transform="rotate(-90 8 8)"
            strokeDasharray={`${(pct / 100) * RING_LENGTH} ${RING_LENGTH}`} />
        </svg>
        <span className="act-meter__pct">{`${pct}%`}</span>
      </span>
    </IconTooltip>
  )
}
