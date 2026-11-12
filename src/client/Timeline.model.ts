// Pure model of the Activity timeline: Senses events -> human-readable lines -> groups.
//
// Imitated designs:
// - Devin "Progress" tab: one chronological feed where each step is grouped under its parent task
//   and links back to the surface that did it. Here a task is one agent turn
//   (`hook.UserPromptSubmit` .. `hook.Stop`), the link is "focus the node".
// - VS Code Sessions view (code.visualstudio.com/docs/agents/run/sessions/manage-sessions): one row
//   per session with status, newest first; here the node/workspace grouping modes.
// - Orca activity feed: repeated identical lines collapse into one row with a count.
// Every label is derived from what the server recorded (DB + hooks), never guessed (PLAN rnd/04 pitfall).
import type { SenseEvent } from '../server/events/eventModel'
import type { WsNode, Workspace } from '../shared/workspace'
import { isAutoMode, isDangerMode, isPermissionKind, permissionText, type LineTone } from './Timeline.permission'

export type TimelineEvent = SenseEvent
export type GroupMode = 'task' | 'node' | 'workspace'
/** Kind filter values: an event family, or everything. */
export type KindFilter = 'all' | 'hook' | 'pty' | 'fs' | 'edge' | 'permissions' | 'auto'

export interface TimelineFilter { workspaceId: string; kind: KindFilter; nodeId: string }
export const NO_FILTER: TimelineFilter = { workspaceId: '', kind: 'all', nodeId: '' }

/** Name/workspace lookups built from the workspace list (+ the live board for fresh titles). */
export interface TimelineContext {
  nodeName(id: string): string
  nodeWorkspace(id: string): string | null
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'name' | 'cwd'>>
}

export interface TimelineLine {
  /** Stable React key: seq, or a synthetic key for unrecorded (seq 0) events. */
  key: string
  ts: number
  text: string
  /** Node a click focuses; null = nothing to jump to. */
  focusId: string | null
  /** Collapsed identical consecutive lines. */
  count: number
  untrusted: boolean
  /** 'warning' = the agent acted without asking (Danger) or a loop was stopped. */
  tone?: LineTone
  /** Done by the system on its own (`auto.*`): tagged "Automatic". */
  auto?: true
  /** High-volume kind whose consecutive run this line summarises (its text holds the count). */
  run?: string
}

export interface TimelineGroup {
  key: string
  label: string
  workspaceId: string | null
  focusId: string | null
  /** Task groups only: still running (no `hook.Stop` yet). */
  running?: boolean
  lastTs: number
  lines: TimelineLine[]
}

export const KIND_LABELS: Record<KindFilter, string> = {
  all: 'All kinds', hook: 'Agent activity', pty: 'Terminal exits', fs: 'File changes', edge: 'Cables', permissions: 'Permissions', auto: 'Automatic',
}
export const GROUP_LABELS: Record<GroupMode, string> = { task: 'Task', node: 'Node', workspace: 'Workspace' }

/** Short id shown when a node is no longer on any board. */
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id)

export function buildContext(workspaces: readonly Workspace[], liveNodes: readonly WsNode[] = [], activeId: string | null = null): TimelineContext {
  const names = new Map<string, string>()
  const owner = new Map<string, string>()
  for (const ws of workspaces) for (const n of ws.nodes ?? []) { owner.set(n.id, ws.id); if (n.title) names.set(n.id, n.title) }
  for (const n of liveNodes) { if (activeId) owner.set(n.id, activeId); if (n.title) names.set(n.id, n.title) }
  return {
    nodeName: (id) => names.get(id) ?? shortId(id),
    nodeWorkspace: (id) => owner.get(id) ?? null,
    workspaces,
  }
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
export const familyOf = (kind: string): string => kind.split('.')[0] ?? kind
/** Filter value an event kind falls under (permission, Central guard and policy events share one). */
export const filterKindOf = (kind: string): string => (isPermissionKind(kind) ? 'permissions' : familyOf(kind))

/** Workspace an event belongs to: recorded id, else its node's board, else the deepest cwd holding an fs path. */
export function workspaceOf(e: TimelineEvent, ctx: TimelineContext): string | null {
  if (e.workspaceId) return e.workspaceId
  if (e.nodeId) { const ws = ctx.nodeWorkspace(e.nodeId); if (ws) return ws }
  const dir = str(rec(e.payload).dir)
  if (!dir) return null
  let best: { id: string; len: number } | null = null
  for (const ws of ctx.workspaces) {
    const cwd = ws.cwd?.replace(/\/+$/, '')
    if (cwd && (dir === cwd || dir.startsWith(`${cwd}/`)) && cwd.length > (best?.len ?? -1)) best = { id: ws.id, len: cwd.length }
  }
  return best?.id ?? null
}

type Described = { text: string; focusId: string | null; tone?: LineTone; auto?: true }

/** Automatic actions the system takes on its own; the list grows server-side, so any `auto.*` counts. */
export const isAutoKind = (kind: string): boolean => kind.startsWith('auto.')
/** High-volume automatic kinds: a consecutive run collapses into one summary line. */
const RUN_SUMMARY: Partial<Record<string, (n: number) => string>> = {
  'auto.mail_delivered': (n) => `Delivered ${n} messages to agents`,
}
/** Readable name for an `auto.*` kind without `text` (old or unknown payloads): "auto.task_done" -> "Automatic: task done". */
export const autoKindName = (kind: string): string => `Automatic: ${kind.slice(5).replace(/[_.]+/g, ' ').trim() || 'action'}`

export interface AutoUndo { label: string; method: 'POST'; path: string; body?: Record<string, unknown> }
/** The undo request an `auto.*` event offers; null when absent or malformed (only same-origin `/api/` POSTs). */
export function autoUndoOf(e: TimelineEvent): AutoUndo | null {
  if (!isAutoKind(e.kind)) return null
  const u = rec(rec(e.payload).undo)
  const label = str(u.label)
  const path = str(u.path)
  if (!label || u.method !== 'POST' || !path?.startsWith('/api/')) return null
  const body = typeof u.body === 'object' && u.body !== null && !Array.isArray(u.body) ? (u.body as Record<string, unknown>) : undefined
  return { label, method: 'POST', path, ...(body ? { body } : {}) }
}

/** Tool plus its (server-redacted, capped) input; old events carry no input. */
const toolWithInput = (tool: string, p: Rec): string => { const input = str(p.input); return input ? `${tool} ${input}` : tool }

const TOOL_HOOKS = new Set(['hook.PreToolUse', 'hook.PostToolUse', 'hook.PostToolUseFailure', 'hook.PermissionRequest'])

function toolUse(name: string, who: string, p: Rec): { text: string; tone?: LineTone } {
  const tool = str(p.toolName)
  const what = tool ? toolWithInput(tool, p) : 'a tool'
  if (name === 'PostToolUseFailure') return { text: `${who} ran ${what} (failed)` }
  if (name === 'PermissionRequest') return { text: `${who} asks permission for ${what}` }
  if (name === 'PostToolUse') return { text: `${who} ran ${what}${p.outcome === 'error' ? ' (failed)' : ''}` }
  if (isDangerMode(p.mode)) return { text: `${who} skipped asking (Danger): ${what}`, tone: 'warning' }
  return { text: `${who} is running ${what}${isAutoMode(p.mode) ? ' (Auto)' : ''}` }
}

function hookText(name: string, who: string, p: Rec): string {
  const preview = str(p.preview)
  switch (name) {
    case 'Stop': return `${who} finished a turn`
    case 'SubagentStop': return `${who}: a subagent finished`
    case 'UserPromptSubmit': return `${who} received a prompt`
    case 'Notification': return preview ? `${who} needs attention: ${preview}` : `${who} needs attention`
    case 'SessionStart': return `${who} started a session`
    case 'SessionEnd': return `${who} ended its session`
    case 'PreCompact': return `${who} is compacting its context`
    default: return `${who}: ${name}`
  }
}

function fsText(p: Rec, ws: Pick<Workspace, 'cwd'> | undefined): string {
  const dir = str(p.dir) ?? '?'
  const count = strs(p.names).length + (typeof p.more === 'number' ? p.more : 0)
  const cwd = ws?.cwd?.replace(/\/+$/, '')
  const rel = cwd && dir === cwd ? './' : cwd && dir.startsWith(`${cwd}/`) ? `${dir.slice(cwd.length + 1)}/` : `${dir}/`
  return `File changes in ${rel} (${count})`
}

/** One line per unordered node pair; a pair seen from both ends is reported once. */
function edgeText(p: Rec, ctx: TimelineContext): { text: string; focusId: string | null } {
  const seen = new Set<string>()
  const lines: string[] = []
  let focusId: string | null = null
  for (const raw of Array.isArray(p.changes) ? p.changes : []) {
    const c = rec(raw)
    const from = str(c.nodeId)
    if (!from) continue
    focusId ??= from
    for (const [list, verb] of [[strs(c.added), 'connected'], [strs(c.removed), 'disconnected'], [strs(c.renamed), 'renamed']] as const) {
      for (const to of list) {
        const pair = `${[from, to].sort().join('|')}|${verb}`
        if (seen.has(pair)) continue
        seen.add(pair)
        lines.push(`Cable: ${ctx.nodeName(from)} ↔ ${ctx.nodeName(to)} ${verb}`)
      }
    }
  }
  if (lines.length === 0) return { text: 'Cables changed', focusId }
  return { text: lines.length === 1 ? lines[0]! : `${lines[0]} (+${lines.length - 1} more)`, focusId }
}

/** Human-readable line for one event. */
export function describeEvent(e: TimelineEvent, ctx: TimelineContext): Described {
  const p = rec(e.payload)
  const who = e.nodeId ? ctx.nodeName(e.nodeId) : 'An agent'
  if (TOOL_HOOKS.has(e.kind)) return { ...toolUse(e.kind.slice(5), who, p), focusId: e.nodeId }
  const perm = permissionText(e.kind, p)
  if (perm) return { ...perm, focusId: e.nodeId }
  if (e.kind.startsWith('hook.')) return { text: hookText(e.kind.slice(5), who, p), focusId: e.nodeId }
  if (e.kind === 'pty.exit') {
    const text = p.reason === 'closed' ? `${who} was closed` : `${who} exited (code ${typeof p.code === 'number' ? p.code : '?'})`
    return { text, focusId: e.nodeId }
  }
  if (e.kind === 'fs.change') {
    const wsId = workspaceOf(e, ctx)
    return { text: fsText(p, ctx.workspaces.find((w) => w.id === wsId)), focusId: null }
  }
  if (e.kind === 'edge.change') return edgeText(p, ctx)
  if (isAutoKind(e.kind)) return { text: str(p.text) ?? autoKindName(e.kind), focusId: e.nodeId, auto: true }
  if (e.kind === 'work.auto_done_set' && str(p.text)) return { text: str(p.text)!, focusId: e.nodeId }
  return { text: e.subject ? `${e.kind} (${e.subject})` : e.kind, focusId: e.nodeId }
}

export function matchesFilter(e: TimelineEvent, f: TimelineFilter, ctx: TimelineContext): boolean {
  if (f.kind !== 'all' && filterKindOf(e.kind) !== f.kind) return false
  if (f.nodeId && e.nodeId !== f.nodeId) return false
  if (f.workspaceId && workspaceOf(e, ctx) !== f.workspaceId) return false
  return true
}

const keyOf = (e: TimelineEvent, i: number): string => (e.seq > 0 ? `s${e.seq}` : `u${e.ts}-${i}`)

/** Groups `events` (ascending) newest-group-first; lines inside a group stay chronological. */
export function groupEvents(events: readonly TimelineEvent[], mode: GroupMode, ctx: TimelineContext): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>()
  const openTurn = new Map<string, TimelineGroup>()
  let turnNo = 0
  const wsName = (id: string | null): string => (id ? ctx.workspaces.find((w) => w.id === id)?.name ?? shortId(id) : 'Other')
  const ensure = (key: string, make: () => Omit<TimelineGroup, 'key' | 'lines' | 'lastTs'>): TimelineGroup => {
    let g = groups.get(key)
    if (!g) { g = { key, lines: [], lastTs: 0, ...make() }; groups.set(key, g) }
    return g
  }
  events.forEach((e, i) => {
    const wsId = workspaceOf(e, ctx)
    const { text, focusId, tone, auto } = describeEvent(e, ctx)
    let g: TimelineGroup
    if (mode === 'workspace' || !e.nodeId) {
      g = ensure(`ws:${wsId ?? ''}`, () => ({ label: wsName(wsId), workspaceId: wsId, focusId: null }))
    } else if (mode === 'node') {
      const id = e.nodeId
      g = ensure(`node:${id}`, () => ({ label: ctx.nodeName(id), workspaceId: wsId, focusId: id }))
    } else {
      const id = e.nodeId
      if (e.kind === 'hook.UserPromptSubmit') {
        const preview = str(rec(e.payload).preview)
        const turn: TimelineGroup = { key: `turn:${id}:${++turnNo}`, label: preview ? `${ctx.nodeName(id)}: ${preview}` : `${ctx.nodeName(id)}: turn`, workspaceId: wsId, focusId: id, running: true, lines: [], lastTs: 0 }
        groups.set(turn.key, turn)
        openTurn.set(id, turn)
      }
      g = openTurn.get(id) ?? ensure(`node:${id}`, () => ({ label: ctx.nodeName(id), workspaceId: wsId, focusId: id }))
      if (e.kind === 'hook.Stop' && openTurn.get(id) === g) { g.running = false; openTurn.delete(id) }
    }
    const last = g.lines[g.lines.length - 1]
    const summary = RUN_SUMMARY[e.kind]
    if (summary && last && last.run === e.kind) { last.count += 1; last.ts = e.ts; last.text = summary(last.count) }
    else if (!summary && last && !last.run && last.text === text && last.focusId === focusId) { last.count += 1; last.ts = e.ts }
    else g.lines.push({ key: keyOf(e, i), ts: e.ts, text, focusId, count: 1, untrusted: e.trust === 'untrusted', ...(tone ? { tone } : {}), ...(auto ? { auto } : {}), ...(summary ? { run: e.kind } : {}) })
    g.lastTs = Math.max(g.lastTs, e.ts)
  })
  return [...groups.values()].sort((a, b) => b.lastTs - a.lastTs)
}

/** Ascending merge, deduped by seq; unrecorded (seq 0) events are kept as they arrive. */
export function mergeEvents(current: readonly TimelineEvent[], incoming: readonly TimelineEvent[], cap: number): TimelineEvent[] {
  const seen = new Set(current.filter((e) => e.seq > 0).map((e) => e.seq))
  const fresh = incoming.filter((e) => e.seq === 0 || !seen.has(e.seq))
  if (fresh.length === 0) return current as TimelineEvent[]
  const all = [...current, ...fresh].sort((a, b) => (a.seq && b.seq ? a.seq - b.seq : a.ts - b.ts))
  return all.length > cap ? all.slice(all.length - cap) : all
}
