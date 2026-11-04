import { createHash } from 'node:crypto'
import { toolProblems } from './toolCapability'
import type { ToolDef, ToolRegistry } from './toolTypes'

// ponytail: chars/4 estimate, swap for a real tokenizer if the budget gets tight
const CHARS_PER_TOKEN = 4

/** Creates an empty registry that rejects duplicate names and malformed capability declarations. */
export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDef>()
  return {
    register(def) {
      if (tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`)
      const problems = toolProblems(def)
      if (problems.length) throw new Error(`tool ${def.name} has an invalid capability declaration: ${problems.join(', ')}`)
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
