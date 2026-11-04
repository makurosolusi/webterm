// cap.search / cap.describe (R0): progressive disclosure over the tool registry, so no tool is hidden
// from a model that only sees part of the list. Both read only the
// caller's registry and report tools whose flag is on, at any tier (the tier says how it can be used).
import { createCapabilityIndex, SEARCH_DEFAULT_LIMIT } from '../../../capability/capability.define'
import { obj, S } from '../../../capability/capability.schema'
import { toolCapability, toolInputSchema } from '../toolCapability'
import { type ToolCtx, type ToolDef, defEnabled } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'

const QUERY_MAX = 200
const SEARCH_MAX = 25
const NAME_MAX = 64

const enabledDefs = (ctx: ToolCtx): ToolDef[] => ctx.registry.list().filter((def) => defEnabled(def, ctx.env ?? process.env))

const capSearch: ToolDef = {
  name: 'cap.search',
  summary: 'Find tools by keyword (name and summary); returns name, summary and tier.',
  tier: 'R0', flag: READ_TOOLS_FLAG, projectScoped: false, auditKeys: ['count'],
  usage: `{"query":"<=${QUERY_MAX} chars, words to match","limit":<1-${SEARCH_MAX}, default ${SEARCH_DEFAULT_LIMIT}>}. Then cap.describe for the schema.`,
  input: obj({ query: S.str(QUERY_MAX), limit: S.int(1, SEARCH_MAX) }, ['query']),
  output: S.keys('count', 'tools'),
  validate: () => null,
  handler(ctx, input) {
    const index = createCapabilityIndex(enabledDefs(ctx).map(toolCapability))
    const tools = index.search(String(input.query), { limit: (input.limit as number | undefined) ?? SEARCH_DEFAULT_LIMIT })
      .map(({ name, summary, tier }) => ({ name, summary, tier }))
    return { ok: true, data: { count: tools.length, tools } }
  },
}

const capDescribe: ToolDef = {
  name: 'cap.describe',
  summary: 'Exact input schema, usage, tier and result shape of one tool by name.',
  tier: 'R0', flag: READ_TOOLS_FLAG, projectScoped: false, auditKeys: ['name'],
  usage: `{"name":"<tool name>"}. Use before calling a tool whose schema the catalog did not show.`,
  input: obj({ name: S.str(NAME_MAX) }, ['name']),
  output: S.keys('name', 'summary', 'tier', 'scope', 'usage', 'input', 'output'),
  validate: () => null,
  handler(ctx, input) {
    const def = enabledDefs(ctx).find((d) => d.name === input.name)
    if (!def) return { ok: false, code: 'not_found' }
    const cap = toolCapability(def)
    return { ok: true, data: { name: def.name, summary: def.summary, tier: def.tier, scope: cap.scope, usage: def.usage, input: toolInputSchema(def) ?? null, output: def.output ?? null } }
  },
}

/** Discovery tools, registered with the Central read group. */
export const CAP_DEFS: readonly ToolDef[] = [capSearch, capDescribe]
