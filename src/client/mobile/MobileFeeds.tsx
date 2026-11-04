// Read-only feeds on the phone: the deterministic morning brief (`GET /api/brief`, the desktop
// card's data and headings) and the recent activity timeline (`GET /api/events/history`, worded
// by the desktop timeline model).
import type { Workspace } from '../../shared/workspace'
import { BRIEF_CATEGORIES, briefHeading } from '../../server/brief/brief.model'
import type { BriefResponse } from '../../server/brief/brief.service'
import { buildContext, describeEvent, type TimelineEvent } from '../Timeline.model'
import { request } from '../inboxTransport'
import { usePoll } from './mobile.poll'

export const TIMELINE_LIMIT = 50
const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function MobileBrief(): React.JSX.Element {
  const { data, error } = usePoll(() => request<BriefResponse>('/api/brief'), 0)
  return (
    <section className="m-screen" aria-label="Brief">
      {error && <p className="m-error" role="alert">{error}</p>}
      {data && data.lines.length === 0 && <p className="m-empty">Nothing new since {new Date(data.since).toLocaleString()}.</p>}
      {data && data.lines.length > 0 && <p className="m-card-meta">Since {new Date(data.since).toLocaleString()}</p>}
      {data && BRIEF_CATEGORIES.map((c) => {
        const lines = data.lines.filter((l) => l.category === c)
        if (lines.length === 0) return null
        return (
          <article key={c} className="m-card">
            <div className="m-card-kind">{briefHeading(c)}</div>
            <ul className="m-list">{lines.map((l) => <li key={l.id}>{l.text}</li>)}</ul>
          </article>
        )
      })}
    </section>
  )
}

export function MobileTimeline(props: { pollMs?: number }): React.JSX.Element {
  const { data, error } = usePoll(async () => {
    const [page, workspaces] = await Promise.all([
      request<{ events: TimelineEvent[] }>(`/api/events/history?limit=${TIMELINE_LIMIT}`),
      request<Workspace[]>('/api/workspaces'),
    ])
    const ctx = buildContext(workspaces)
    return [...page.events].reverse().map((e) => ({ key: String(e.seq), ts: e.ts, text: describeEvent(e, ctx).text }))
  }, props.pollMs ?? 10_000)
  return (
    <section className="m-screen" aria-label="Timeline">
      {error && <p className="m-error" role="alert">{error}</p>}
      {data && data.length === 0 && <p className="m-empty">No activity yet.</p>}
      {data && data.length > 0 && (
        <ol className="m-timeline">
          {data.map((l) => <li key={l.key}><time>{time(l.ts)}</time><span>{l.text}</span></li>)}
        </ol>
      )}
    </section>
  )
}
