// Task DAG model (F4-b), pure: no I/O, no bun:sqlite, vitest-safe.
//
// Imitated (Orca, /tmp/st/orca-src src/main/runtime/orchestration):
// - human-only decision gates, re-blocked every tick: `coordinator-decision-gates.ts:51-60`
// - escalation bound to the exact dispatch + 3-strike circuit breaker: `coordinator-escalation-triage.ts:20-62`
// - stale-base guard, 20 commits, `allow-stale-base` escape hatch: `coordinator-stale-base-flag.ts:1-16`,
//   refused before any dispatch row so drift never spends breaker budget: `coordinator-task-dispatch.ts:71-85`
// - concurrency cap 4: `coordinator.ts:31-32,228`
// Anthropic "How we built our multi-agent research system": every sub-agent brief carries an objective,
// an output format, tool guidance and task boundaries, and effort is scaled to complexity explicitly.
// File leases are the webterm addition (PLAN/rnd/04 #5): overlapping leases never run in parallel.
import { resolveCommand, DEFAULT_EXECUTABLES, type ConfiguredCommand } from '../orchestrator/verifyCommands'

export const BREAKER_THRESHOLD = 3
export const DISPATCH_STALE_THRESHOLD = 20
export const DAG_MAX_CONCURRENT = 4
export const DAG_MAX_TASKS = 100
const TEXT_MAX = 4000
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type DagTaskKind = 'work' | 'gate'
export type DagTaskStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed'
export type DagStatus = 'active' | 'done' | 'failed' | 'cancelled'
export type Effort = 'simple' | 'moderate' | 'complex'

/** Anthropic effort scaling, applied to one worker: a tool-call budget in the prompt and a wall clock. */
export const EFFORT_SCALE: Readonly<Record<Effort, { toolCalls: string; timeoutMs: number }>> = {
  simple: { toolCalls: '3-10 tool calls', timeoutMs: 10 * 60_000 },
  moderate: { toolCalls: '10-30 tool calls', timeoutMs: 30 * 60_000 },
  complex: { toolCalls: 'up to 100 tool calls; split the work into steps and verify each', timeoutMs: 60 * 60_000 },
}

/** Mandatory structured brief. Gate nodes need only `objective` (the question) and `nextAction`. */
export interface Brief {
  objective: string
  outputFormat: string
  /** Claude Code tool names, passed as `--allowedTools`. */
  tools: string[]
  boundaries: string
  /** Argv the verifier runs as the test check (allowlisted executable, no shell). */
  verifyCmd: ConfiguredCommand
  nextAction: string
  effort: Effort
  /** Paths the task may change; `dir/**` = everything under `dir`. */
  lease: string[]
  allowStaleBase?: boolean
  /** Gate nodes: the choices offered to the human. */
  options?: string[]
}

export interface DagTaskInput { key: string; kind?: DagTaskKind; deps?: string[]; brief: unknown }

export interface DagTask {
  id: string
  dagId: string
  key: string
  kind: DagTaskKind
  brief: Brief
  deps: string[]
  status: DagTaskStatus
  failureCount: number
  lastError: string | null
  decision: string | null
}

export class DagError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DagError'
  }
}

const text = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new DagError('invalid_brief', `brief.${label} is required`)
  if (v.length > TEXT_MAX) throw new DagError('invalid_brief', `brief.${label} is longer than ${TEXT_MAX} chars`)
  return v.trim()
}

const strings = (v: unknown, label: string, max = 50): string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= 300)) {
    throw new DagError('invalid_brief', `brief.${label} must be 1..${max} non-empty strings`)
  }
  return [...new Set(v.map((s: string) => s.trim()))]
}

/**
 * A lease entry -> the literal path prefix it covers. `src/a/**` and `src/a/*.ts` both lease `src/a`.
 * ponytail: a mid-path glob widens to its literal prefix, so overlap is over-approximated (two tasks may
 * serialize that could have run together); it never under-approximates. Real glob intersection if it matters.
 */
export function leasePrefix(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').split('/')
  const literal: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') throw new DagError('invalid_lease', `lease escapes the worktree: ${raw}`)
    if (/[*?[{]/.test(p)) break
    literal.push(p)
  }
  if (raw.trim().startsWith('/')) throw new DagError('invalid_lease', `lease must be relative: ${raw}`)
  return literal.join('/')
}

/** Two leases overlap when one prefix contains the other ('' = the whole worktree, overlaps everything). */
export function leasesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const covers = (x: string, y: string) => x === '' || x === y || y.startsWith(`${x}/`)
  return a.some((x) => b.some((y) => covers(leasePrefix(x), leasePrefix(y)) || covers(leasePrefix(y), leasePrefix(x))))
}

export function validateBrief(raw: unknown, kind: DagTaskKind): Brief {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DagError('invalid_brief', 'brief must be an object')
  const b = raw as Record<string, unknown>
  if (kind === 'gate') {
    const options = b.options === undefined ? undefined : strings(b.options, 'options', 10)
    return { objective: text(b.objective, 'objective'), nextAction: text(b.nextAction, 'nextAction'), outputFormat: '', tools: [], boundaries: '', verifyCmd: { file: '', args: [] }, effort: 'simple', lease: [], ...(options ? { options } : {}) }
  }
  if (typeof b.effort !== 'string' || !(b.effort in EFFORT_SCALE)) throw new DagError('invalid_brief', `brief.effort must be one of ${Object.keys(EFFORT_SCALE).join(', ')}`)
  const lease = strings(b.lease, 'lease')
  lease.forEach(leasePrefix)
  const cmd = b.verifyCmd as ConfiguredCommand | undefined
  const resolved = resolveCommand('test', cmd && typeof cmd === 'object' ? cmd : ({ file: '', args: [] } as ConfiguredCommand), DEFAULT_EXECUTABLES)
  if (!resolved.ok) throw new DagError('invalid_brief', `brief.verifyCmd: ${resolved.message}`)
  return {
    objective: text(b.objective, 'objective'), outputFormat: text(b.outputFormat, 'outputFormat'),
    tools: strings(b.tools, 'tools'), boundaries: text(b.boundaries, 'boundaries'), verifyCmd: resolved.command,
    nextAction: text(b.nextAction, 'nextAction'), effort: b.effort as Effort, lease,
    ...(b.allowStaleBase === true ? { allowStaleBase: true } : {}),
  }
}

/** Validates keys, deps and briefs; throws on a cycle. Returns the inputs in a topological order. */
export function validateTasks(raw: unknown): Array<{ key: string; kind: DagTaskKind; deps: string[]; brief: Brief }> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DAG_MAX_TASKS) throw new DagError('invalid_tasks', `tasks must be 1..${DAG_MAX_TASKS} items`)
  const byKey = new Map<string, { key: string; kind: DagTaskKind; deps: string[]; brief: Brief }>()
  for (const t of raw as DagTaskInput[]) {
    if (!t || typeof t.key !== 'string' || !KEY_RE.test(t.key)) throw new DagError('invalid_tasks', `task key must match ${KEY_RE}`)
    if (byKey.has(t.key)) throw new DagError('invalid_tasks', `duplicate task key ${t.key}`)
    const kind = t.kind ?? 'work'
    if (kind !== 'work' && kind !== 'gate') throw new DagError('invalid_tasks', `task ${t.key}: kind must be work or gate`)
    const deps = t.deps ?? []
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) throw new DagError('invalid_tasks', `task ${t.key}: deps must be task keys`)
    byKey.set(t.key, { key: t.key, kind, deps: [...new Set(deps)], brief: validateBrief(t.brief, kind) })
  }
  for (const t of byKey.values()) for (const d of t.deps) if (!byKey.has(d)) throw new DagError('invalid_tasks', `task ${t.key} depends on unknown ${d}`)
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string, path: string[]): void => {
    if (state.get(key) === 'done') return
    if (state.get(key) === 'visiting') throw new DagError('dag_cycle', `dependency cycle: ${[...path, key].join(' -> ')}`)
    state.set(key, 'visiting')
    for (const d of byKey.get(key)!.deps) visit(d, [...path, key])
    state.set(key, 'done')
    order.push(key)
  }
  for (const key of byKey.keys()) visit(key, [])
  return order.map((k) => byKey.get(k)!)
}

/**
 * Automatic waves: a task runs in the wave after its last dependency, then later still while its lease
 * overlaps a task already placed in that wave. This is the preview of what the scheduler does live.
 */
export function planWaves(tasks: ReadonlyArray<Pick<DagTask, 'key' | 'deps' | 'brief'>>): string[][] {
  const waveOf = new Map<string, number>()
  const waves: Array<Array<Pick<DagTask, 'key' | 'brief'>>> = []
  const pending = [...tasks]
  while (pending.length > 0) {
    const i = pending.findIndex((t) => t.deps.every((d) => waveOf.has(d)))
    if (i < 0) throw new DagError('dag_cycle', 'dependency cycle')
    const [t] = pending.splice(i, 1)
    let w = Math.max(-1, ...t.deps.map((d) => waveOf.get(d)!)) + 1
    while (waves[w]?.some((o) => leasesOverlap(o.brief.lease, t.brief.lease))) w++
    ;(waves[w] ??= []).push(t)
    waveOf.set(t.key, w)
  }
  return waves.map((w) => w.map((t) => t.key))
}

export interface WorkerSignal { kind: 'gate'; question: string; options?: string[] }
export interface EscalationSignal { kind: 'escalate'; reason: string }

/**
 * Signals a worker may end its final message with. They can only make the run MORE conservative
 * (block on a human, or fail the attempt); completion never comes from worker text.
 */
export function parseWorkerSignal(output: string): WorkerSignal | EscalationSignal | null {
  const gate = /^DECISION_GATE:\s*(\{.*\})\s*$/m.exec(output)
  if (gate) {
    try {
      const p = JSON.parse(gate[1]) as { question?: unknown; options?: unknown }
      if (typeof p.question === 'string' && p.question.trim()) {
        const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string').slice(0, 10) : undefined
        return { kind: 'gate', question: p.question.trim().slice(0, 1000), ...(options?.length ? { options } : {}) }
      }
    } catch { /* a malformed gate line is ignored like any other output; the verifier still decides */ }
  }
  const esc = /^ESCALATE:\s*(.+)$/m.exec(output)
  return esc ? { kind: 'escalate', reason: esc[1].trim().slice(0, 500) } : null
}

/** The worker prompt: the structured brief, the effort budget and the two signals it may send. */
export function renderBrief(task: Pick<DagTask, 'key' | 'brief' | 'decision'>): string {
  const b = task.brief
  return [
    `You are a webterm DAG worker for task "${task.key}". Work only in this git worktree.`,
    `Objective: ${b.objective}`,
    `Output format: ${b.outputFormat}`,
    `Tools: ${b.tools.join(', ')}`,
    `Boundaries: ${b.boundaries}`,
    `Files you own (lease): ${b.lease.join(', ')}. Changing any other file fails the task.`,
    `Effort: ${b.effort} (${EFFORT_SCALE[b.effort].toolCalls}).`,
    `Done means: \`${[b.verifyCmd.file, ...b.verifyCmd.args].join(' ')}\` passes and the diff stays inside the lease. The server checks this itself; your own report is not evidence.`,
    `Next action after this task: ${b.nextAction}`,
    ...(task.decision ? [`A human decided earlier: ${task.decision}`] : []),
    'If a decision only a human can make blocks you, end your final message with one line:',
    'DECISION_GATE: {"question": "...", "options": ["...", "..."]}',
    'If you cannot finish, end with one line: ESCALATE: <reason>',
  ].join('\n')
}
