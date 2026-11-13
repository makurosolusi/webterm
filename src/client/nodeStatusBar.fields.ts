// The items of a node status bar (short text + full value) and its "Copy diagnostics" JSON, built from
// the page's stream view (nodeActivity.store), the server facts (nodeStatus.store) and the clock.
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import type { NodeActivity } from './nodeActivity.store'
import type { ConnectionPhase } from './ws.connection'
import { anomaliesOf, formatAge, type Anomaly, type StatusBarFacts } from './nodeStatusBar.rules'

export type StatusBarKind = 'terminal' | 'agent'
/** `label` is the plain English name of the field, shown in the details popover. */
export interface StatusBarItem { id: string; label: string; text: string; full: string }

const COST_DIGITS = 2
const COST_FULL_DIGITS = 4
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export interface StatusBarInput {
  kind: StatusBarKind
  now: number
  connection: ConnectionPhase
  activity?: NodeActivity
  info?: NodeStatusInfo
  cwd?: string
}

/** Facts for the anomaly rules: the page's own exit first (it knows "closed by us"), else the server's. */
export function factsOf(i: StatusBarInput): StatusBarFacts {
  const agent = i.kind === 'agent'
  return {
    now: i.now,
    connection: i.connection,
    exit: i.activity?.exit ?? (i.info && !i.info.live ? i.info.exit : undefined),
    lastOutputAt: i.activity?.lastOutputAt,
    ...(agent && i.info ? {
      status: i.info.status, statusSince: i.info.statusSince, lastHookAt: i.info.lastHookAt,
      contextPct: i.info.contextPct, outbox: i.info.outbox, work: i.info.work,
    } : {}),
  }
}

/** Debug facts of the PTY: details popover only (VS Code: hover detail, not status bar items). */
function sessionDetails(i: StatusBarInput, f: StatusBarFacts): StatusBarItem[] {
  const out: StatusBarItem[] = []
  const { info, activity: a, now } = i
  if (f.exit) {
    out.push({ id: 'state', label: 'Process', text: `exited ${f.exit.code}`, full: `Exited with code ${f.exit.code}${f.exit.reason ? ` (${f.exit.reason})` : ''}, ${formatAge(now - f.exit.at)} ago` })
  } else if (info) {
    out.push(info.live ? { id: 'state', label: 'Process', text: 'running', full: 'Running' } : { id: 'state', label: 'Process', text: 'not running', full: 'No process runs for this node' })
  }
  if (!f.exit && info?.pid !== undefined) out.push({ id: 'pid', label: 'Process ID', text: `${info.pid}`, full: `${info.pid}` })
  if (!f.exit && info?.startedAt !== undefined) {
    out.push({ id: 'uptime', label: 'Running for', text: formatAge(now - info.startedAt), full: `${formatAge(now - info.startedAt)} (since ${clock(info.startedAt)})` })
  }
  if (a?.cols && a.rows) out.push({ id: 'size', label: 'Terminal size', text: `${a.cols}×${a.rows}`, full: `${a.cols} columns × ${a.rows} rows` })
  if (a?.lastOutputAt !== undefined) out.push({ id: 'output', label: 'Last output', text: formatAge(now - a.lastOutputAt), full: `${formatAge(now - a.lastOutputAt)} ago` })
  return out
}

function agentDetails(info: NodeStatusInfo | undefined, now: number): StatusBarItem[] {
  if (!info) return []
  const out: StatusBarItem[] = []
  if (info.status) {
    const dur = info.statusSince !== undefined ? formatAge(now - info.statusSince) : undefined
    out.push({ id: 'agent', label: 'Agent status', text: dur ? `${info.status} ${dur}` : info.status, full: dur ? `${info.status}, for ${dur}` : `${info.status} (since before the last server restart)` })
  }
  if (info.lastHookAt !== undefined) out.push({ id: 'hook', label: 'Last hook', text: formatAge(now - info.lastHookAt), full: `${formatAge(now - info.lastHookAt)} ago` })
  // Shown only when mail is waiting: an empty outbox is not news (a stuck one is an anomaly badge).
  if (info.outbox?.queued) {
    const q = info.outbox.queued
    out.push({ id: 'outbox', label: 'Outbox', text: `${q} queued`, full: `${q} queued ${q === 1 ? 'message' : 'messages'}` })
  }
  return out
}

/** What the user acts on: where (folder), which model, how full the context is, the cost, the task. */
function visibleItems(i: StatusBarInput): StatusBarItem[] {
  const out: StatusBarItem[] = []
  const info = i.kind === 'agent' ? i.info : undefined
  if (i.cwd) out.push({ id: 'cwd', label: 'Folder', text: baseName(i.cwd), full: `Working directory: ${i.cwd}` })
  if (info?.model) out.push({ id: 'model', label: 'Model', text: info.model.replace(/^claude-/, ''), full: `Model: ${info.model}` })
  if (info?.contextPct !== undefined) out.push({ id: 'context', label: 'Context', text: `ctx ${Math.round(info.contextPct)}%`, full: `Context window ${info.contextPct}% used after the last response` })
  if (info?.costUsd !== undefined) {
    out.push({ id: 'cost', label: 'Cost', text: `$${info.costUsd.toFixed(COST_DIGITS)}`, full: `Session cost $${info.costUsd.toFixed(COST_FULL_DIGITS)} (responses with a known price)` })
  }
  if (info?.work) {
    out.push({ id: 'task', label: 'Task', text: `Task: ${info.work.status}`, full: `Task “${info.work.title}”: ${info.work.status}, assigned ${formatAge(i.now - info.work.startedAt)} ago` })
  }
  return out
}

/** `items` are on the bar, `details` only in its popover; the live state is the header chip's. */
export interface StatusBarModel { items: StatusBarItem[]; details: StatusBarItem[]; anomalies: Anomaly[] }

/** Everything one bar shows. */
export function statusBarModel(i: StatusBarInput): StatusBarModel {
  const f = factsOf(i)
  const details = sessionDetails(i, f)
  if (i.kind === 'agent') details.push(...agentDetails(i.info, i.now))
  return { items: visibleItems(i), details, anomalies: anomaliesOf(f) }
}

/**
 * JSON for "Copy diagnostics": the SHORT item texts (the cwd as its folder name, the task as its
 * status, never its title), the anomalies and the connection. No prompt text, token or path (Rule 12).
 */
export function diagnosticsJson(nodeId: string, i: StatusBarInput, m: StatusBarModel): string {
  return JSON.stringify({
    node: nodeId, kind: i.kind, at: new Date(i.now).toISOString(), connection: i.connection,
    fields: Object.fromEntries([...m.items, ...m.details].map((x) => [x.id, x.text])),
    anomalies: m.anomalies,
  }, null, 2)
}
