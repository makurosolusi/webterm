// Morning brief (PLAN F3-e): a deterministic digest, no LLM. Pure functions only (vitest-safe):
// the same events + counts always give the same lines in the same order.
//
// Imitated: GitHub's notification digest and Linear's "Pulse" — one line per thing that changed,
// what needs you first, each line a link to where you act on it.
import { MODEL_IDS, TIER_TABLE, type LadderModel, type Tier } from '../models/modelLadder'

/** Display order: what needs you first, then what broke, then what simply happened. */
export const BRIEF_CATEGORIES = ['stuck', 'gates', 'tests', 'restored', 'finished', 'checkpoints', 'cost'] as const
export type BriefCategory = (typeof BRIEF_CATEGORIES)[number]

/** Where a click on a line goes (client decides how: focus node / open Inbox / new Diff node). */
export type BriefTarget = { kind: 'node'; nodeId: string } | { kind: 'inbox' } | { kind: 'diff'; workspaceId: string } | null

export interface BriefLine {
  /** Stable id (`<category>:<key>`), so the client can key rows. */
  id: string
  category: BriefCategory
  text: string
  target: BriefTarget
}

export interface Brief {
  /** Window start (epoch ms): the user's last active time before this visit. */
  since: number
  generatedAt: number
  /** Event-log head the brief was built from (cache key). */
  headSeq: number
  lines: BriefLine[]
}

/** The event fields the brief reads. */
export interface BriefEvent {
  ts: number
  kind: string
  nodeId: string | null
  workspaceId: string | null
  payload: unknown
}

export interface BriefUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  costMicros: number
  /** Calls whose price was not known: the cost shown is then a lower bound. */
  unpriced: number
}

/** Last 7 days of spend (cost ledger), for the weekly cost lines. */
export interface BriefWeekly {
  /** Spend per cost source (central / agent / helper). */
  bySource: ReadonlyArray<{ source: string; costMicros: number }>
  /** Spend per model id as recorded (null = unknown model). */
  byModel: ReadonlyArray<{ model: string | null; costMicros: number }>
  /** DAG run spend and the work tasks that passed verification in the window. */
  dagCostMicros: number
  verifiedTasks: number
  centralTurns: number
  centralFailed: number
}

export interface BriefInput {
  since: number
  now: number
  headSeq: number
  /** Ascending by ts/seq, already filtered to ts > since. */
  events: readonly BriefEvent[]
  inbox: { needsYou: number; review: number } | null
  usage: BriefUsage | null
  weekly?: BriefWeekly | null
  nodeLabel: (nodeId: string) => string
  workspaceLabel: (workspaceId: string) => string
}

/** Kinds read by `buildBrief`; the SQL source filters on these (plus `hook.*`). */
export const BRIEF_KINDS = ['pty.exit', 'test.fail', 'orchestrator.verify_failed', 'checkpoint.created', 'checkpoint.rewound', 'agent.restored'] as const

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {})

/** 12345 -> "12.3k"; 1234567 -> "1.2M". */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Builds the brief lines. Deterministic: ties are broken by label, then id. */
export function buildBrief(input: BriefInput): Brief {
  const finished = new Map<string, number>()
  const lastStatus = new Map<string, string>()
  const failures = new Map<string, { count: number; code: number | null; label: string }>()
  const checkpoints = new Map<string, { created: number; rewound: number }>()
  const restored = new Set<string>()

  for (const e of input.events) {
    const p = obj(e.payload)
    if (e.kind.startsWith('hook.') && e.nodeId) {
      if (e.kind === 'hook.Stop') finished.set(e.nodeId, (finished.get(e.nodeId) ?? 0) + 1)
      if (typeof p['status'] === 'string') lastStatus.set(e.nodeId, p['status'])
    } else if (e.kind === 'pty.exit' && e.nodeId) {
      lastStatus.delete(e.nodeId) // an exited node is not waiting on anyone
      const code = typeof p['code'] === 'number' ? p['code'] : 0
      if (p['reason'] === 'self' && code !== 0) {
        const f = failures.get(`node:${e.nodeId}`) ?? { count: 0, code, label: input.nodeLabel(e.nodeId) }
        failures.set(`node:${e.nodeId}`, { ...f, count: f.count + 1, code })
      }
    } else if (e.kind === 'test.fail' || e.kind === 'orchestrator.verify_failed') {
      const key = e.nodeId ? `node:${e.nodeId}` : `kind:${e.kind}`
      const label = e.nodeId ? input.nodeLabel(e.nodeId) : e.kind === 'test.fail' ? 'A test run' : 'Task verification'
      const f = failures.get(key) ?? { count: 0, code: null, label }
      failures.set(key, { ...f, count: f.count + 1, code: null })
    } else if ((e.kind === 'checkpoint.created' || e.kind === 'checkpoint.rewound') && e.workspaceId) {
      const c = checkpoints.get(e.workspaceId) ?? { created: 0, rewound: 0 }
      if (e.kind === 'checkpoint.created') c.created += 1
      else c.rewound += 1
      checkpoints.set(e.workspaceId, c)
    } else if (e.kind === 'agent.restored' && e.nodeId) {
      restored.add(e.nodeId)
    }
  }

  const lines: BriefLine[] = []
  const byLabel = <T>(entries: Iterable<[string, T]>, label: (key: string, v: T) => string): Array<[string, T, string]> =>
    [...entries].map(([k, v]): [string, T, string] => [k, v, label(k, v)]).sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]))

  for (const [id, status, label] of byLabel(lastStatus, (id) => input.nodeLabel(id))) {
    if (status === 'waiting') lines.push({ id: `stuck:${id}`, category: 'stuck', text: `${label} needs your input`, target: { kind: 'node', nodeId: id } })
    if (status === 'blocked') lines.push({ id: `stuck:${id}`, category: 'stuck', text: `${label} is waiting for permission`, target: { kind: 'node', nodeId: id } })
  }
  if (input.inbox && input.inbox.needsYou > 0) {
    lines.push({ id: 'gates:needs_you', category: 'gates', text: `${plural(input.inbox.needsYou, 'approval or blocked task')} waiting in the Central chat`, target: { kind: 'inbox' } })
  }
  if (input.inbox && input.inbox.review > 0) {
    lines.push({ id: 'gates:review', category: 'gates', text: `${plural(input.inbox.review, 'task')} ready for review`, target: { kind: 'inbox' } })
  }
  for (const [key, f] of byLabel(failures, (_k, f) => f.label)) {
    const nodeId = key.startsWith('node:') ? key.slice(5) : null
    const what = f.code !== null ? `exited with code ${f.code}` : 'failed'
    lines.push({ id: `tests:${key}`, category: 'tests', text: `${f.label} ${what}${f.count > 1 ? ` (${f.count} times)` : ''}`, target: nodeId ? { kind: 'node', nodeId } : { kind: 'inbox' } })
  }
  for (const [id, , label] of byLabel([...restored].map((id): [string, null] => [id, null]), (id) => input.nodeLabel(id))) {
    lines.push({ id: `restored:${id}`, category: 'restored', text: `${label} was restored after the server restart`, target: { kind: 'node', nodeId: id } })
  }
  for (const [id, n, label] of byLabel(finished, (id) => input.nodeLabel(id))) {
    lines.push({ id: `finished:${id}`, category: 'finished', text: `${label} finished ${plural(n, 'turn')}`, target: { kind: 'node', nodeId: id } })
  }
  for (const [ws, c, label] of byLabel(checkpoints, (ws) => input.workspaceLabel(ws))) {
    const parts = [c.created ? plural(c.created, 'checkpoint') : '', c.rewound ? plural(c.rewound, 'rewind') : ''].filter(Boolean)
    lines.push({ id: `checkpoints:${ws}`, category: 'checkpoints', text: `${parts.join(', ')} in ${label}`, target: { kind: 'diff', workspaceId: ws } })
  }
  const u = input.usage
  if (u && u.calls > 0) {
    const cost = `$${(u.costMicros / 1_000_000).toFixed(2)}${u.unpriced > 0 ? '+ (some prices unknown)' : ''}`
    lines.push({ id: 'cost:total', category: 'cost', text: `${compactCount(u.inputTokens)} input / ${compactCount(u.outputTokens)} output tokens across ${plural(u.calls, 'call')}, ${cost}`, target: null })
  }
  lines.push(...weeklyLines(input.weekly ?? null))
  return { since: input.since, generatedAt: input.now, headSeq: input.headSeq, lines }
}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`

/** `claude-opus-5-5` -> `opus (T3)`; an id outside the ladder keeps its name. */
function modelLabel(model: string | null): string {
  if (model === null) return 'unknown model'
  const m = model.toLowerCase()
  const alias = (Object.keys(MODEL_IDS) as LadderModel[]).find((a) => m.includes(a))
  const tier = alias ? (Object.keys(TIER_TABLE) as Tier[]).find((t) => TIER_TABLE[t].model === alias) : undefined
  return alias ? `${alias} (${tier})` : model
}

/** Weekly cost lines: spend by kind, by model/tier, cost per verified task, Central turn failure rate. */
export function weeklyLines(w: BriefWeekly | null): BriefLine[] {
  if (!w) return []
  const total = w.bySource.reduce((sum, r) => sum + r.costMicros, 0)
  const lines: BriefLine[] = []
  const line = (key: string, text: string) => lines.push({ id: `cost:week:${key}`, category: 'cost', text, target: null })
  const sorted = <T extends { costMicros: number }>(rows: readonly T[], label: (r: T) => string): string =>
    [...rows].filter((r) => r.costMicros > 0).sort((a, b) => b.costMicros - a.costMicros || label(a).localeCompare(label(b)))
      .map((r) => `${label(r)} ${usd(r.costMicros)}`).join(', ')
  if (total > 0) {
    line('kind', `Last 7 days: ${usd(total)} (${sorted(w.bySource, (r) => r.source)})`)
    // Ids of one alias (e.g. two opus versions) merge into one entry.
    const byLabel = new Map<string, number>()
    for (const r of w.byModel) byLabel.set(modelLabel(r.model), (byLabel.get(modelLabel(r.model)) ?? 0) + r.costMicros)
    line('model', `By model: ${sorted([...byLabel].map(([label, costMicros]) => ({ label, costMicros })), (r) => r.label)}`)
  }
  if (w.verifiedTasks > 0 && w.dagCostMicros > 0) {
    line('verified', `Cost per verified task: ${usd(w.dagCostMicros / w.verifiedTasks)} (${plural(w.verifiedTasks, 'task')})`)
  }
  if (w.centralTurns > 0) {
    line('central', `Central turns: ${w.centralTurns}, ${w.centralFailed} failed (${Math.round((w.centralFailed / w.centralTurns) * 100)}%)`)
  }
  return lines
}

const HEADINGS: Record<BriefCategory, string> = {
  stuck: 'Needs you', gates: 'Gates', tests: 'Failures', restored: 'Restored', finished: 'Finished', checkpoints: 'Checkpoints', cost: 'Usage',
}

/** Category heading shown above its lines (client and Telegram use the same words). */
export const briefHeading = (c: BriefCategory): string => HEADINGS[c]

/**
 * Plain-text rendering for the Telegram worker (F3 channel digest): headings + "- " bullets,
 * no markup, so the shared Telegram renderer can escape it like any other reply.
 */
export function renderBriefText(brief: Brief, sinceText = new Date(brief.since).toISOString().slice(0, 16).replace('T', ' ')): string {
  if (brief.lines.length === 0) return `Morning brief: nothing new since ${sinceText}.`
  const out = [`Morning brief since ${sinceText}`]
  for (const c of BRIEF_CATEGORIES) {
    const group = brief.lines.filter((l) => l.category === c)
    if (group.length === 0) continue
    out.push('', briefHeading(c), ...group.map((l) => `- ${l.text}`))
  }
  return out.join('\n')
}
