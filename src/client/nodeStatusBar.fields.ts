// The items of a node status bar (short text + full value) and its "Copy diagnostics" JSON, built from
// the page's stream view (nodeActivity.store), the server facts (nodeStatus.store) and the clock.
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import type { NodeActivity } from './nodeActivity.store'
import type { ConnectionPhase } from './ws.connection'
import { anomaliesOf, formatAge, type Anomaly, type StatusBarFacts } from './nodeStatusBar.rules'

export type StatusBarKind = 'terminal' | 'agent'
export interface StatusBarItem { id: string; text: string; full: string }

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

function sessionItems(i: StatusBarInput, f: StatusBarFacts): StatusBarItem[] {
  const out: StatusBarItem[] = []
  const { info, activity: a, now } = i
  if (f.exit) {
    out.push({ id: 'state', text: `exited ${f.exit.code}`, full: `Session exited with code ${f.exit.code}${f.exit.reason ? ` (${f.exit.reason})` : ''}, ${formatAge(now - f.exit.at)} ago` })
  } else if (info) {
    out.push(info.live ? { id: 'state', text: 'live', full: 'Session is running' } : { id: 'state', text: 'not running', full: 'No process runs for this node' })
  }
  if (!f.exit && info?.pid !== undefined) out.push({ id: 'pid', text: `pid ${info.pid}`, full: `Process id ${info.pid}` })
  if (!f.exit && info?.startedAt !== undefined) {
    out.push({ id: 'uptime', text: `up ${formatAge(now - info.startedAt)}`, full: `Started at ${clock(info.startedAt)}, ${formatAge(now - info.startedAt)} ago` })
  }
  if (a?.cols && a.rows) out.push({ id: 'size', text: `${a.cols}×${a.rows}`, full: `Terminal size: ${a.cols} columns × ${a.rows} rows` })
  if (i.cwd) out.push({ id: 'cwd', text: baseName(i.cwd), full: `Working directory: ${i.cwd}` })
  if (a?.lastOutputAt !== undefined) out.push({ id: 'output', text: `out ${formatAge(now - a.lastOutputAt)}`, full: `Last output ${formatAge(now - a.lastOutputAt)} ago` })
  return out
}

function agentItems(info: NodeStatusInfo | undefined, now: number): StatusBarItem[] {
  if (!info) return []
  const out: StatusBarItem[] = []
  if (info.status) {
    const dur = info.statusSince !== undefined ? ` ${formatAge(now - info.statusSince)}` : ''
    out.push({ id: 'agent', text: `${info.status}${dur}`, full: `Agent is ${info.status}${dur ? `, for${dur}` : ' (since before the last server restart)'}` })
  }
  if (info.lastHookAt !== undefined) out.push({ id: 'hook', text: `hook ${formatAge(now - info.lastHookAt)}`, full: `Last hook event ${formatAge(now - info.lastHookAt)} ago` })
  if (info.model) out.push({ id: 'model', text: info.model.replace(/^claude-/, ''), full: `Model: ${info.model}` })
  if (info.contextPct !== undefined) out.push({ id: 'context', text: `ctx ${Math.round(info.contextPct)}%`, full: `Context window ${info.contextPct}% used after the last response` })
  if (info.costUsd !== undefined) {
    out.push({ id: 'cost', text: `$${info.costUsd.toFixed(COST_DIGITS)}`, full: `Session cost $${info.costUsd.toFixed(COST_FULL_DIGITS)} (responses with a known price)` })
  }
  if (info.work) {
    out.push({ id: 'task', text: `task ${info.work.status}`, full: `Task “${info.work.title}”: ${info.work.status}, assigned ${formatAge(now - info.work.startedAt)} ago` })
  }
  if (info.outbox) {
    const q = info.outbox.queued
    out.push({ id: 'outbox', text: `outbox ${q}`, full: q ? `${q} queued ${q === 1 ? 'message' : 'messages'} in the outbox` : 'Outbox empty' })
  }
  return out
}

export interface StatusBarModel { items: StatusBarItem[]; anomalies: Anomaly[] }

/** Everything one bar shows. */
export function statusBarModel(i: StatusBarInput): StatusBarModel {
  const f = factsOf(i)
  const items = sessionItems(i, f)
  if (i.kind === 'agent') items.splice(1, 0, ...agentItems(i.info, i.now))
  return { items, anomalies: anomaliesOf(f) }
}

/**
 * JSON for "Copy diagnostics": the SHORT item texts (the cwd as its folder name, the task as its
 * status, never its title), the anomalies and the connection. No prompt text, token or path (Rule 12).
 */
export function diagnosticsJson(nodeId: string, i: StatusBarInput, m: StatusBarModel): string {
  return JSON.stringify({
    node: nodeId, kind: i.kind, at: new Date(i.now).toISOString(), connection: i.connection,
    fields: Object.fromEntries(m.items.map((x) => [x.id, x.text])),
    anomalies: m.anomalies,
  }, null, 2)
}
