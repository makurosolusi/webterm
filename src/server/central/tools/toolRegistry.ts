import { createHash } from 'node:crypto'
import { flagOn } from '../../envFlag'
import { type Tier, type ToolDef, type ToolRegistry, tierWithin } from './toolTypes'

export const CATALOG_TOKEN_BUDGET = 1200
// ponytail: chars/4 estimate, swap for a real tokenizer if the budget gets tight
const CHARS_PER_TOKEN = 4

/** Creates an empty registry that rejects duplicate tool names. */
export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDef>()
  return {
    register(def) {
      if (tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`)
      if (def.summary.length > 120) throw new Error(`tool summary exceeds 120 chars: ${def.name}`)
      tools.set(def.name, def)
    },
    list: () => [...tools.values()],
    get: (name) => tools.get(name),
  }
}

/** Stable sha256 over name/tier/summary/usage of all tools, independent of registration order. */
export function toolsHash(registry: ToolRegistry): string {
  const canon = registry.list()
    .map(({ name, tier, summary, usage }) => ({ name, tier, summary, usage }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

/** Estimated prompt tokens of a text. */
export function estimateTokens(text: string): number { return Math.ceil(text.length / CHARS_PER_TOKEN) }

/** Tools visible at `maxTier` with their flag on, in registration order. */
export function activeTools(registry: ToolRegistry, maxTier: Tier, env: Record<string, string | undefined> = process.env): ToolDef[] {
  return registry.list().filter((def) => tierWithin(def.tier, maxTier) && (!def.flag || flagOn(env[def.flag])))
}

/** Prompt catalog (`name usage` per tool) for tools up to `maxTier`; drops tools that would exceed the token budget. */
export function renderCatalog(registry: ToolRegistry, maxTier: Tier, env?: Record<string, string | undefined>): string {
  const lines: string[] = []
  let used = 0
  for (const def of activeTools(registry, maxTier, env)) {
    const line = `${def.name} ${def.usage}`
    const cost = estimateTokens(line) + 1
    if (used + cost > CATALOG_TOKEN_BUDGET) continue
    used += cost
    lines.push(line)
  }
  return lines.join(' ')
}
