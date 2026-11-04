import { createHash } from 'node:crypto'
import { createLogger } from '../../logs'
import { toolProblems } from './toolCapability'
import { type Tier, type ToolDef, type ToolRegistry, defEnabled, tierWithin } from './toolTypes'

const log = createLogger('central.tools')

export const CATALOG_TOKEN_BUDGET = 1200
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

/** Tools visible at `maxTier` with their flag on, in registration order. */
export function activeTools(registry: ToolRegistry, maxTier: Tier, env: Record<string, string | undefined> = process.env): ToolDef[] {
  return registry.list().filter((def) => tierWithin(def.tier, maxTier) && defEnabled(def, env))
}

/** Tool the overflow note points to; it is kept first when the catalog is over budget so its own schema is never cut. */
export const DESCRIBE_TOOL = 'cap.describe'
/** Token room reserved for the overflow note's fixed text; the names list fills whatever is left. */
const NOTE_RESERVE = 48

export interface Catalog {
  text: string
  /** Active tools whose schema did not fit the budget; each is still named (or counted) in the note. */
  omitted: string[]
}

/**
 * Prompt catalog (`name usage` per tool) for tools up to `maxTier`, within `budget` tokens. A catalog
 * that fits is rendered exactly as before. Over budget, nothing is dropped silently: a closing note
 * names the omitted tools (as many as fit, then a count) and points to `cap.describe`, and the
 * overflow is logged once per distinct omitted set.
 */
export function buildCatalog(registry: ToolRegistry, maxTier: Tier, env?: Record<string, string | undefined>, budget = CATALOG_TOKEN_BUDGET): Catalog {
  const active = activeTools(registry, maxTier, env)
  const lines = active.map((def) => `${def.name} ${def.usage}`)
  const cost = (line: string): number => estimateTokens(line) + 1
  if (lines.reduce((sum, line) => sum + cost(line), 0) <= budget) return { text: lines.join(' '), omitted: [] }
  const describeAt = active.findIndex((def) => def.name === DESCRIBE_TOOL)
  const order = describeAt < 0 ? [...lines.keys()] : [describeAt, ...[...lines.keys()].filter((i) => i !== describeAt)]
  // Greedy fill, then grow the reserve until the note can name every omitted tool (capped at half the
  // budget, past which the note names what fits and counts the rest). Converges in a few passes.
  let kept: number[] = []
  let omitted: string[] = []
  let used = 0
  let reserve = NOTE_RESERVE
  for (let pass = 0; pass < 5; pass++) {
    kept = []; omitted = []; used = reserve
    for (const i of order) {
      const c = cost(lines[i] as string)
      if (used + c > budget) { omitted.push((active[i] as ToolDef).name); continue }
      used += c
      kept.push(i)
    }
    const want = Math.min(Math.floor(budget / 2), NOTE_RESERVE + estimateTokens(omitted.join(', ')))
    if (want <= reserve) break
    reserve = want
  }
  warnOverflow(omitted)
  // Kept lines stay in registration order (deterministic prefix for the prompt cache).
  const text = [...kept.sort((a, b) => a - b).map((i) => lines[i]), overflowNote(omitted, describeAt >= 0, budget - (used - reserve) - NOTE_RESERVE)].join(' ')
  return { text, omitted }
}

function overflowNote(omitted: readonly string[], describable: boolean, roomTokens: number): string {
  const how = describable ? `call ${DESCRIBE_TOOL} {"name":"<tool>"} for the exact schema first` : 'their schemas are unavailable this turn'
  const names: string[] = []
  let left = roomTokens * CHARS_PER_TOKEN
  for (const name of omitted) {
    if (name.length + 2 > left) break
    names.push(name)
    left -= name.length + 2
  }
  const rest = omitted.length - names.length
  return `[${omitted.length} more tools over the catalog budget; ${how}: ${names.join(', ')}${rest > 0 ? ` and ${rest} others (cap.search finds them)` : ''}]`
}

let lastOverflow = ''
function warnOverflow(omitted: readonly string[]): void {
  const key = omitted.join(',')
  if (key === lastOverflow) return
  lastOverflow = key
  log.warn('central.catalog.overflow', 'Tool catalog over budget; omitted schemas are reachable through cap.describe', { omitted: omitted.length, names: omitted.slice(0, 20).join(',') })
}

/** Prompt catalog text; see `buildCatalog`. */
export function renderCatalog(registry: ToolRegistry, maxTier: Tier, env?: Record<string, string | undefined>): string {
  return buildCatalog(registry, maxTier, env).text
}
