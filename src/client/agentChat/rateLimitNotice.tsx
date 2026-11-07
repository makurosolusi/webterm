// Plan usage limit notice of the agent chat (server `rateLimit` events from the SDK rate_limit_event):
// one banner that is replaced, never stacked, and goes away once a turn succeeds or the limit lifts.
import type { RateLimitView } from './agentChatStore'

const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', overage: 'extra usage',
  seven_day_overage_included: 'weekly',
}

/** "at 3:40 PM" today, else with the date. */
export function resetText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay
    ? `at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : `on ${d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

export function rateLimitText(r: RateLimitView, now = Date.now()): string {
  const name = r.limit ? LIMIT_NAME[r.limit] ?? 'usage' : 'usage'
  const reset = r.resetsAt && r.resetsAt > now ? ` It resets ${resetText(r.resetsAt, now)}.` : ''
  if (r.status === 'rejected') return `You have hit your ${name} limit. Claude cannot answer until it resets.${reset}`
  const used = typeof r.utilization === 'number' ? ` (${Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization)}% used)` : ''
  return `You are close to your ${name} limit${used}.${reset}`
}

export function RateLimitNotice({ limit }: { limit?: RateLimitView }) {
  if (!limit) return null
  return (
    <div className={`agent-chat-banner agent-chat-banner--${limit.status === 'rejected' ? 'error' : 'warn'}`} role="status" aria-label="Usage limit">
      <span className={`codicon codicon-${limit.status === 'rejected' ? 'error' : 'warning'}`} aria-hidden="true" />
      <span>{rateLimitText(limit)}</span>
    </div>
  )
}
