// The registry the `webterm` CLI projects (plan F2-b): every capability with an HTTP binding, so
// `POST /api/tools/:name` can execute it. Discovery is generated from it, like Orca
// `src/cli/agent-context.ts:27-52` (`buildAgentContext(specs)`: sorted, schemaVersion, count), plus a
// per-caller `allowed` flag and a content version used by `whats-new` and the versioned skill guide.
import { createHash } from 'node:crypto'
import { createCapabilityIndex, type CapabilitySpec, type Tier } from '../capability/capability.define'
import type { JsonSchema } from '../capability/capability.schema'
import { CONTROL_CAPABILITIES } from '../capability/control.capabilities'
import { GIT_CAPABILITIES } from '../capability/git.capabilities'
import { REPORT_CAPABILITIES } from '../capability/report.capabilities'
import type { Effect } from '../policy/policy.model'
import { SKILL_CAPABILITIES } from '../capability/skill.capabilities'
import { SECRET_CAPABILITIES } from '../secrets/secret.capabilities'

/** Bump when the agent-context JSON shape changes (Orca `SCHEMA_VERSION`). */
export const AGENT_CONTEXT_SCHEMA_VERSION = 1

/** Capabilities reachable through `/api/tools/:name`; Central-only tools have no route and stay out. */
export const TOOL_INDEX = createCapabilityIndex([...CONTROL_CAPABILITIES, ...GIT_CAPABILITIES, ...SECRET_CAPABILITIES, ...REPORT_CAPABILITIES, ...SKILL_CAPABILITIES].filter((c) => c.route))

/** What `whats-new` compares: the parts of a capability an agent depends on. */
export interface RegistryEntry { name: string; summary: string; tier: Tier; scope: string; input: JsonSchema; destructive: boolean }
export interface RegistrySnapshot { version: string; capabilities: RegistryEntry[] }

const entryOf = (c: CapabilitySpec): RegistryEntry =>
  ({ name: c.name, summary: c.summary, tier: c.tier, scope: c.scope, input: c.input, destructive: c.destructive === true })

/** Snapshot of `caps` (name order) with a content hash as its version: same registry, same version. */
export function snapshotOf(caps: readonly CapabilitySpec[] = TOOL_INDEX.list()): RegistrySnapshot {
  const capabilities = caps.map(entryOf).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const version = createHash('sha256').update(JSON.stringify(capabilities)).digest('hex').slice(0, 12)
  return { version, capabilities }
}

export interface RegistryDiff {
  added: string[]
  removed: string[]
  changed: { name: string; fields: string[] }[]
}

const FIELDS = ['summary', 'tier', 'scope', 'input', 'destructive'] as const

/** What changed from `before` to `after`; a null `before` (never seen) reports everything as added. */
export function diffRegistry(before: RegistrySnapshot | null, after: RegistrySnapshot): RegistryDiff {
  const old = new Map((before?.capabilities ?? []).map((e) => [e.name, e]))
  const now = new Map(after.capabilities.map((e) => [e.name, e]))
  const changed: RegistryDiff['changed'] = []
  for (const [name, e] of now) {
    const prior = old.get(name)
    if (!prior) continue
    const fields = FIELDS.filter((f) => JSON.stringify(prior[f]) !== JSON.stringify(e[f]))
    if (fields.length) changed.push({ name, fields })
  }
  return {
    added: [...now.keys()].filter((n) => !old.has(n)),
    removed: [...old.keys()].filter((n) => !now.has(n)),
    changed,
  }
}

export interface AgentContextEntry extends RegistryEntry {
  idempotent: boolean
  /** True when policy allows this caller right now; `decision` says why not otherwise. */
  allowed: boolean
  decision: Effect
}

export interface AgentContext {
  schemaVersion: number
  registryVersion: string
  principal: string
  capabilityCount: number
  capabilities: AgentContextEntry[]
}

/** Discovery for one caller; `judge` is the policy answer for that caller (injected: no I/O here). */
export function buildAgentContext(principal: string, judge: (cap: CapabilitySpec) => Effect, caps: readonly CapabilitySpec[] = TOOL_INDEX.list()): AgentContext {
  const snap = snapshotOf(caps)
  const byName = new Map(caps.map((c) => [c.name, c]))
  const capabilities = snap.capabilities.map((e) => {
    const cap = byName.get(e.name) as CapabilitySpec
    const decision = judge(cap)
    return { ...e, idempotent: cap.idempotent === true, allowed: decision === 'allow', decision }
  })
  return { schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION, registryVersion: snap.version, principal, capabilityCount: capabilities.length, capabilities }
}

/** Plain-text discovery (`webterm agent-context` without `--json`), Orca `formatAgentContextSummary`. */
export function formatAgentContext(ctx: AgentContext): string {
  const rows = ctx.capabilities.map((c) => `${c.name.padEnd(18)} ${c.tier}  ${c.decision.padEnd(5)}  ${c.summary}`)
  return [
    `${ctx.capabilityCount} capabilities (registry ${ctx.registryVersion}, schema v${ctx.schemaVersion}) for ${ctx.principal}.`,
    ...rows,
    'Run `webterm agent-context --json` for input schemas; call one with `webterm <name> --json \'{...}\'`.',
  ].join('\n')
}

/** Plain-text `whats-new`. */
export function formatDiff(since: string | null, version: string, d: RegistryDiff): string {
  const head = since === version ? `No changes since registry ${version}.` : `Registry ${since ?? '(never seen)'} -> ${version}.`
  const lines = [
    ...d.added.map((n) => `+ ${n}`),
    ...d.removed.map((n) => `- ${n}`),
    ...d.changed.map((c) => `~ ${c.name} (${c.fields.join(', ')})`),
  ]
  return [head, ...lines].join('\n')
}
