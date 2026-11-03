// `agent.kinds` (R0, CA-02): lists the agent kinds central may pass to `agent.spawn`. Read-only and
// model-safe: id, label, builtin and headless flags only, never argv, program, env or paths.
// There is deliberately no tool that defines or edits an agent (D11): definitions are human-only.
import type { AgentCatalog } from '../../agents/agentCatalog'
import type { ToolDef } from '../toolTypes'
import { flagged } from './agent.defs'

/** Builds the `agent.kinds` tool over the catalog. */
export function createAgentKindsDef(catalog: AgentCatalog): ToolDef {
  return {
    name: 'agent.kinds', summary: 'List agent kinds that agent.spawn accepts (id, label, builtin, headless).', tier: 'R0', auditKeys: ['count'],
    usage: '{"projectId":"<id>"}. A custom kind always needs a human approval to spawn.',
    validate: (input) => (Object.keys(input).every((k) => k === 'projectId') ? null : 'invalid_shape'),
    handler: flagged(() => {
      const kinds = catalog.kinds()
      return { ok: true, data: { kinds, count: kinds.length } }
    }),
  }
}
