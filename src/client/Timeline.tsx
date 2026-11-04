// Activity timeline in the bottom panel (PLAN F1-e): every recorded signal as one readable line,
// grouped by task / node / workspace, filterable, click to jump to the node. Grouping and wording
// live in ./Timeline.model; the live feed in ./Timeline.stream; level + integrity in ./Timeline.status.
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { Workspace, WsNode } from '../shared/workspace'
import { VscodeTooltip } from './components/vscode/vscodeTooltip'
import { LEVEL_NAMES } from './central/centralLabels'
import { useRegisterCommands, type Command } from './commandRegistry'
import { InboxPanelSurface } from './inboxPanelSurface'
import type { BottomPanelTab } from './bottomPanelTabs'
import {
  GROUP_LABELS, KIND_LABELS, NO_FILTER, buildContext, groupEvents, matchesFilter,
  type GroupMode, type KindFilter, type TimelineFilter,
} from './Timeline.model'
import { useTimelineFeed } from './Timeline.stream'
import { effectiveLevel, useTimelineStatus, type ControlSnapshot, type Integrity } from './Timeline.status'
import './Timeline.css'

/** localStorage key for the open state. */
export const TIMELINE_OPEN_KEY = 'webterm.timelineOpen'
const TABS: BottomPanelTab[] = [{ id: 'activity', label: 'Activity', closable: false, tooltip: 'Activity' }]
const noop = (): void => {}

/* --- Open state: one module store so the palette command and the panel share it ---------------- */

const listeners = new Set<() => void>()
let open = ((): boolean => { try { return localStorage.getItem(TIMELINE_OPEN_KEY) === '1' } catch { return false } })()
/** Opens or closes the Activity panel (persisted per browser). */
export function setTimelineOpen(next: boolean): void {
  open = next
  try { localStorage.setItem(TIMELINE_OPEN_KEY, next ? '1' : '0') } catch { /* private mode: this tab only */ }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const useTimelineOpen = (): boolean => useSyncExternalStore(subscribe, () => open, () => open)

const COMMANDS: Command[] = [{ id: 'view.toggleActivity', label: 'View: Toggle Activity', run: () => setTimelineOpen(!open) }]

/* --- Panel ------------------------------------------------------------------------------------------ */

export interface TimelinePanelProps {
  workspaces: readonly Workspace[]
  /** Nodes of the active board (fresher titles than the saved snapshot). */
  liveNodes?: readonly WsNode[]
  activeId?: string | null
  onFocusNode: (id: string) => void
}

const timeOf = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function IntegrityChip({ integrity }: { integrity: Integrity }): React.JSX.Element {
  const label = integrity.state === 'ok' ? 'Chain verified' : integrity.state === 'warning' ? 'Chain warning' : 'Chain unknown'
  const title = integrity.state === 'ok' ? `Event chain intact up to #${integrity.seq}` : integrity.state === 'warning' ? integrity.reason : 'Event chain not checked (ledger off or unreachable)'
  // VS Code hover, like the Output toolbar; the reason is also the accessible name.
  return (
    <VscodeTooltip content={title}>
      <span className="timeline-integrity" data-state={integrity.state} role="status" tabIndex={0} aria-label={`${label}: ${title}`}>{label}</span>
    </VscodeTooltip>
  )
}

function LevelBadge({ control, workspaceId }: { control: ControlSnapshot | null; workspaceId: string | null }): React.JSX.Element | null {
  if (!control || !workspaceId) return null
  const level = effectiveLevel(control, workspaceId)
  const name = LEVEL_NAMES[level]
  return <span className="timeline-level" data-level={level} title={`Autonomy: ${name}`}>{name.split(' ')[0]}</span>
}

/** The panel body; exported separately so tests mount it without the open store. */
export function TimelinePanel({ workspaces, liveNodes, activeId = null, onFocusNode }: TimelinePanelProps): React.JSX.Element {
  const feed = useTimelineFeed(true)
  const { control, integrity } = useTimelineStatus(true, feed.epoch)
  const [mode, setMode] = useState<GroupMode>('task')
  const [filter, setFilter] = useState<TimelineFilter>(NO_FILTER)
  const ctx = useMemo(() => buildContext(workspaces, liveNodes, activeId), [workspaces, liveNodes, activeId])
  const agents = useMemo(() => [...new Set(feed.events.flatMap((e) => (e.nodeId ? [e.nodeId] : [])))], [feed.events])
  const groups = useMemo(
    () => groupEvents(feed.events.filter((e) => matchesFilter(e, filter, ctx)), mode, ctx),
    [feed.events, filter, mode, ctx],
  )
  const wsName = (id: string | null): string | null => (id ? workspaces.find((w) => w.id === id)?.name ?? null : null)
  const patch = (p: Partial<TimelineFilter>): void => setFilter((f) => ({ ...f, ...p }))

  return (
    <div className="timeline" aria-label="Activity timeline">
      <div className="timeline-toolbar">
        <label>Group <select aria-label="Group by" value={mode} onChange={(e) => setMode(e.target.value as GroupMode)}>
          {(Object.keys(GROUP_LABELS) as GroupMode[]).map((m) => <option key={m} value={m}>{GROUP_LABELS[m]}</option>)}
        </select></label>
        <select aria-label="Filter by workspace" value={filter.workspaceId} onChange={(e) => patch({ workspaceId: e.target.value })}>
          <option value="">All workspaces</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select aria-label="Filter by kind" value={filter.kind} onChange={(e) => patch({ kind: e.target.value as KindFilter })}>
          {(Object.keys(KIND_LABELS) as KindFilter[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
        <select aria-label="Filter by agent" value={filter.nodeId} onChange={(e) => patch({ nodeId: e.target.value })}>
          <option value="">All agents</option>
          {agents.map((id) => <option key={id} value={id}>{ctx.nodeName(id)}</option>)}
        </select>
        <span className="timeline-spacer" />
        <span className="timeline-connection" data-state={feed.connection} title={feed.error ?? undefined}>
          {feed.connection === 'open' ? 'Live' : feed.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
        <IntegrityChip integrity={integrity} />
      </div>
      <div className="timeline-body">
        {groups.length === 0 && <p className="timeline-empty">No activity yet.</p>}
        {groups.map((g) => (
          <section key={g.key} className="timeline-group" data-group={g.key} data-running={g.running ? 'true' : undefined}>
            <header className="timeline-group__head">
              {g.focusId
                ? <button type="button" className="timeline-group__label" onClick={() => onFocusNode(g.focusId!)} title="Focus node">{g.label}</button>
                : <span className="timeline-group__label">{g.label}</span>}
              {g.running && <span className="timeline-running">running</span>}
              {mode !== 'workspace' && wsName(g.workspaceId) && <span className="timeline-ws">{wsName(g.workspaceId)}</span>}
              <LevelBadge control={control} workspaceId={g.workspaceId} />
            </header>
            <ul className="timeline-lines">
              {g.lines.map((l) => {
                const body = <><time>{timeOf(l.ts)}</time> <span className="timeline-text">{l.text}</span>{l.count > 1 && <span className="timeline-count"> ×{l.count}</span>}</>
                return (
                  <li key={l.key} className="timeline-line" data-untrusted={l.untrusted ? 'true' : undefined}>
                    {l.focusId ? <button type="button" onClick={() => onFocusNode(l.focusId!)}>{body}</button> : <span>{body}</span>}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {feed.more && (
          <button type="button" className="timeline-older" disabled={feed.loadingOlder} onClick={() => void feed.loadOlder()}>
            {feed.loadingOlder ? 'Loading…' : 'Load older activity'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Always-mounted host: registers "View: Toggle Activity" and renders the panel while open. */
export default function TimelineHost(props: TimelinePanelProps): React.JSX.Element | null {
  useRegisterCommands(COMMANDS)
  const isOpen = useTimelineOpen()
  if (!isOpen) return null
  return (
    <InboxPanelSurface className="timeline-panel-host" ariaLabel="Activity" tabs={TABS} activeId="activity" onActivate={noop} onClosePanel={() => setTimelineOpen(false)}>
      <TimelinePanel {...props} />
    </InboxPanelSurface>
  )
}
