// Policy simulator (PLAN F4-d, rnd/10 #2 "dry-run"): replays the last 7 days of `policy.decision` and Claude
// permission events against a proposed rule set (and/or the classifier switch) and reports what would have
// changed. Read-only: nothing is executed, no rule is written, the classifier is never called.
// Both sides are replayed (current rules vs proposed rules), so the diff isolates the proposal itself.
import type { Database } from 'bun:sqlite'
import { allRows } from '../ledger/ledgerCore'
import { PERMISSION_DECISION_EVENT, PERMISSION_REQUEST_EVENT } from '../permission/permission.wait'
import { TOOL_CAPABILITY_PREFIX } from '../permission/permission.model'
import { DECISION_EVENT, isDestructive } from './policy.decide'
import { EFFECTS, evaluate, type Effect, type Grant } from './policy.model'
import { neverAutoReason } from './policy.classifier'

export const SIM_WINDOW_MS = 7 * 24 * 3_600_000
/** ponytail: newest N events only; page through seq if a week ever holds more. */
export const SIM_EVENT_CAP = 5000
const EXAMPLES_MAX = 20

export interface SimRule { subject: string; capability: string; scope?: string; effect: Effect }
export interface SimProposal { add?: SimRule[]; remove?: string[]; classifier?: boolean }
export type SimEffect = Effect | 'classifier'
type Counts = Record<SimEffect, number>
export interface SimExample { seq: number; ts: number; principal: string; capability: string; resource: string | null; before: SimEffect; after: SimEffect; reason: string }
export interface SimReport {
  from: number; to: number; total: number; truncated: boolean
  before: Counts; after: Counts; changed: number
  /** Asks the classifier would have seen but the never-auto list kept with the human. */
  neverAutoHeld: number
  examples: SimExample[]
}

interface Replay { seq: number; ts: number; principal: string; capability: string; resource: string | null; permission: boolean; tool: string }

const zero = (): Counts => ({ allow: 0, ask: 0, deny: 0, classifier: 0 })

/** `Bash(npm test)` -> `npm test`; the event keeps only a capped preview, so long resources replay truncated. */
const labelResource = (label: string): string | null => /^[\w.:-]+\((.*)\)$/s.exec(label)?.[1] ?? null

function loadEvents(db: Database, from: number): { rows: Replay[]; truncated: boolean } {
  const raw = allRows(db, 'SELECT seq, ts, kind, actor, subject, payload_json FROM event WHERE kind IN (?, ?, ?) AND ts >= ? ORDER BY seq DESC LIMIT ?',
    DECISION_EVENT, PERMISSION_REQUEST_EVENT, PERMISSION_DECISION_EVENT, from, SIM_EVENT_CAP + 1)
  const rows: Replay[] = []
  for (const r of raw.slice(0, SIM_EVENT_CAP)) {
    const p = JSON.parse(String(r['payload_json'])) as Record<string, unknown>
    const kind = String(r['kind'])
    const base = { seq: Number(r['seq']), ts: Number(r['ts']) }
    if (kind === DECISION_EVENT && typeof p.capability === 'string') {
      rows.push({ ...base, principal: String(r['actor']), capability: p.capability, resource: r['subject'] === null ? null : String(r['subject']), permission: false, tool: p.capability })
      continue
    }
    // A prompt is one `permission.request` (went to a human) or one rule-answered `permission.decision`.
    const prompt = kind === PERMISSION_REQUEST_EVENT || (kind === PERMISSION_DECISION_EVENT && p.by === 'rule')
    const subject = String(r['subject'] ?? '')
    if (!prompt || typeof p.tool !== 'string' || !subject.startsWith('node:')) continue
    rows.push({ ...base, principal: subject, capability: `${TOOL_CAPABILITY_PREFIX}${p.tool}`, resource: typeof p.label === 'string' ? labelResource(p.label) : null, permission: true, tool: p.tool })
  }
  return { rows: rows.reverse(), truncated: raw.length > SIM_EVENT_CAP }
}

function replay(rules: readonly Grant[], e: Replay, at: number): Effect {
  const d = evaluate(rules, { principal: e.principal, capability: e.capability, ...(e.resource !== null ? { resource: e.resource } : {}), now: at })
  // permission.wait: only a human-ui allow/deny answers a prompt; anything else prompts.
  if (e.permission) return d.origin === 'human-ui' && d.effect !== 'ask' ? d.effect : 'ask'
  if (isDestructive(e.capability) && d.effect === 'allow' && d.origin !== 'human-ui' && d.origin !== 'builtin') return 'ask'
  return d.effect
}

/** Valid proposed rules as grants (appended last, so they win like a fresh human rule); invalid ones throw. */
export function proposedGrants(current: readonly Grant[], p: SimProposal, now: number): Grant[] {
  const removed = new Set(p.remove ?? [])
  const added = (p.add ?? []).map((r, i): Grant => {
    const ok = (s: unknown): s is string => typeof s === 'string' && s !== '' && s.length <= 200
    if (!ok(r.subject) || !ok(r.capability) || (r.scope !== undefined && !ok(r.scope)) || !EFFECTS.includes(r.effect)) throw new RangeError(`rule ${i} is invalid`)
    return { id: `sim-${i + 1}`, subject: r.subject, capability: r.capability, scope: r.scope ?? '*', effect: r.effect, expiresAt: null, origin: 'human-ui', createdBy: 'human-ui', createdAt: now }
  })
  return [...current.filter((g) => !removed.has(g.id)), ...added]
}

/** Replays the window. `current` = live rules (`policy.store.grants()`), `classifierOn` = today's switch. */
export function simulatePolicy(db: Database, current: readonly Grant[], proposal: SimProposal, opts: { now: number; classifierOn: boolean; windowMs?: number }): SimReport {
  const from = opts.now - (opts.windowMs ?? SIM_WINDOW_MS)
  const next = proposedGrants(current, proposal, opts.now)
  const classifierAfter = proposal.classifier ?? opts.classifierOn
  const { rows, truncated } = loadEvents(db, from)
  const report: SimReport = { from, to: opts.now, total: rows.length, truncated, before: zero(), after: zero(), changed: 0, neverAutoHeld: 0, examples: [] }
  const viaClassifier = (e: Replay, eff: Effect, on: boolean, count: boolean): SimEffect => {
    if (!on || eff !== 'ask') return eff
    const args = e.tool === 'Bash' ? { command: e.resource ?? '' } : { path: e.resource ?? '' }
    // The replay has no tier or cwd: absolute paths count as outside, like a node without a known cwd.
    const never = neverAutoReason({ capability: e.capability, tier: 'R2', args, destructive: isDestructive(e.capability) })
    if (never && count) report.neverAutoHeld++
    return never ? 'ask' : 'classifier'
  }
  for (const e of rows) {
    const before = viaClassifier(e, replay(current, e, e.ts), opts.classifierOn, false)
    const after = viaClassifier(e, replay(next, e, e.ts), classifierAfter, true)
    report.before[before]++
    report.after[after]++
    if (before === after) continue
    report.changed++
    if (report.examples.length < EXAMPLES_MAX) {
      report.examples.push({ seq: e.seq, ts: e.ts, principal: e.principal, capability: e.capability, resource: e.resource, before, after, reason: after === 'classifier' ? 'would go to the classifier instead of you' : `proposed rules: ${after}` })
    }
  }
  return report
}
