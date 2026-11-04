// Capability registry core, modelled on Orca `defineMethod` (src/main/runtime/rpc/core.ts:181-193):
// every capability declares its name, schema and permission tier up front, and projections
// (Central catalog, control HTTP, later MCP/CLI) are derived from that one declaration.
import type { Tier } from '../central/contracts/level.types'
import { type JsonSchema, isObjectSchema } from './capability.schema'

export type { Tier }
export const TIERS: readonly Tier[] = ['R0', 'R1', 'R2', 'R3']

/** Surfaces a capability is projected to; the drift test checks each one lists it. */
export type Projection = 'central' | 'control-http'
/** What the capability acts on; the authorization resource kind. */
export type CapabilityScope = 'project' | 'node' | 'workspace' | 'global'

/** HTTP binding for capabilities whose handler is a route (control verbs). `:param` segments are placeholders. */
export interface CapabilityRoute { method: 'GET' | 'POST'; path: string }

export interface CapabilitySpec {
  /** Dotted or snake name, unique across the registry. */
  name: string
  /** One line, at most 120 chars. */
  summary: string
  /** Every capability must explicitly choose its tier (Orca: "Every new method must explicitly choose caller permissions"). */
  tier: Tier
  scope: CapabilityScope
  input: JsonSchema
  output: JsonSchema
  projections: readonly Projection[]
  /** Same input twice has the same effect as once (safe to replay / cache). */
  idempotent?: boolean
  /** Irreversible; never auto-approved. */
  destructive?: boolean
  route?: CapabilityRoute
}

export const SUMMARY_MAX = 120
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

/** Problems that make `spec` an invalid capability; empty when it is well formed. */
export function capabilityProblems(spec: Partial<CapabilitySpec>): string[] {
  const out: string[] = []
  if (!spec.name || !NAME_RE.test(spec.name)) out.push('name')
  if (!spec.summary || spec.summary.length > SUMMARY_MAX) out.push('summary')
  if (!spec.tier || !TIERS.includes(spec.tier)) out.push('tier')
  if (!spec.scope) out.push('scope')
  if (!isObjectSchema(spec.input)) out.push('input')
  if (!isObjectSchema(spec.output)) out.push('output')
  if (!spec.projections?.length) out.push('projections')
  if (spec.projections?.includes('control-http') && !spec.route) out.push('route')
  return out
}

/** Declares a capability; throws on a malformed spec so a bad declaration fails at import, not at call time. */
export function defineCapability<T extends CapabilitySpec>(spec: T): T {
  const problems = capabilityProblems(spec)
  if (problems.length) throw new Error(`invalid capability ${spec.name || '<unnamed>'}: ${problems.join(', ')}`)
  return spec
}

/** Discovery entry returned by `search`. */
export interface CapabilityHit { name: string; summary: string; tier: Tier; projections: readonly Projection[] }

export interface CapabilityIndex {
  list(): CapabilitySpec[]
  get(name: string): CapabilitySpec | undefined
  /** Case-insensitive term match over name + summary, best first; `projection` narrows the set. */
  search(query: string, opts?: { limit?: number; projection?: Projection }): CapabilityHit[]
}

export const SEARCH_DEFAULT_LIMIT = 10

/**
 * Read view over a set of capabilities, sorted by name (deterministic order keeps prompt caches stable).
 * The same name declared by two surfaces (e.g. `approval.request` in Central and control HTTP) is one
 * capability projected twice: tier and scope must agree, projections are merged, the first schema wins.
 */
export function createCapabilityIndex(caps: readonly CapabilitySpec[]): CapabilityIndex {
  const byName = new Map<string, CapabilitySpec>()
  for (const cap of caps) {
    const prior = byName.get(cap.name)
    if (!prior) { byName.set(cap.name, cap); continue }
    if (prior.tier !== cap.tier || prior.scope !== cap.scope) throw new Error(`capability ${cap.name} declared twice with a different tier or scope`)
    byName.set(cap.name, { ...prior, projections: [...new Set([...prior.projections, ...cap.projections])] })
  }
  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    list: () => [...sorted],
    get: (name) => byName.get(name),
    search(query, opts = {}) {
      const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
      const pool = opts.projection ? sorted.filter((c) => c.projections.includes(opts.projection as Projection)) : sorted
      const scored = pool
        .map((cap) => {
          const name = cap.name.toLowerCase()
          const text = `${name} ${cap.summary.toLowerCase()}`
          // A name hit outranks a summary hit; an empty query lists everything.
          const score = terms.reduce((sum, t) => sum + (name.includes(t) ? 2 : text.includes(t) ? 1 : 0), 0)
          return { cap, score }
        })
        .filter((s) => terms.length === 0 || s.score > 0)
        .sort((a, b) => b.score - a.score)
      return scored.slice(0, opts.limit ?? SEARCH_DEFAULT_LIMIT)
        .map(({ cap }) => ({ name: cap.name, summary: cap.summary, tier: cap.tier, projections: cap.projections }))
    },
  }
}
