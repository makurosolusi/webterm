// Central ToolDef -> capability projection. A ToolDef is a capability plus Central-only extras
// (usage text, flag gate, validate/handler over ToolCtx); this is the one mapping between them.
import { type CapabilitySpec, capabilityProblems } from '../../capability/capability.define'
import type { JsonSchema } from '../../capability/capability.schema'
import type { ToolDef } from './toolTypes'

const PROJECT_ID: JsonSchema = { type: 'string', minLength: 1, maxLength: 200, description: 'Ledger project id (one per canvas workspace).' }

/** Full input schema: the def's own schema, plus a required `projectId` for project-scoped tools. */
export function toolInputSchema(def: ToolDef): JsonSchema | undefined {
  if (!def.input || def.projectScoped === false) return def.input
  return { ...def.input, properties: { projectId: PROJECT_ID, ...def.input.properties }, required: ['projectId', ...(def.input.required ?? [])] }
}

/** The capability a tool def declares (projection `central`); input/output stay undefined when the def has none. */
export function toolCapability(def: ToolDef): CapabilitySpec {
  return {
    name: def.name, summary: def.summary, tier: def.tier, scope: def.projectScoped === false ? 'global' : 'project',
    input: toolInputSchema(def) as JsonSchema, output: def.output as JsonSchema, projections: ['central'],
  }
}

/** Problems in a def's capability declaration; schema problems only count once the def declares a schema. */
export function toolProblems(def: ToolDef): string[] {
  const problems = capabilityProblems(toolCapability(def))
  return def.input ? problems : problems.filter((p) => p !== 'input' && p !== 'output')
}
