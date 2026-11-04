// `agent.spawn` (F2-h): the one capability every spawn door goes through (control API, orchestrator
// worker, Central agents; the canvas next). Declared like every other capability (capability.define.ts),
// and `agentSpawn.ts` checks each request against this input schema at its boundary.
import { defineCapability } from '../capability/capability.define'
import { obj, S } from '../capability/capability.schema'

export const AGENT_SPAWN_MODES = ['pty', 'headless'] as const
export type AgentSpawnMode = (typeof AGENT_SPAWN_MODES)[number]

export const AGENT_SPAWN_CAPABILITY = defineCapability({
  name: 'agent.spawn', summary: 'Start an agent (claude by default) as a canvas PTY node or a headless run, under its parent.',
  tier: 'R2', scope: 'project', projections: ['central'],
  input: obj({
    kind: S.str(100, { description: 'Agent kind; defaults to claude.' }),
    mode: S.oneOf(...AGENT_SPAWN_MODES),
    workspaceId: S.str(200),
    cwd: S.str(4096, { description: 'Absolute working directory (a worktree path for workers); required for headless.' }),
    prompt: S.str(32768, { description: 'First prompt; required for headless.' }),
    parent: S.str(200, { description: 'Principal that spawns: human-ui, central or node:<id>.' }),
    title: S.str(200, { description: 'Display name; made unique among live agents.' }),
    nodeId: S.str(200),
  }, ['mode', 'parent']),
  output: obj({ ok: S.bool(), childId: S.str(), nodeId: S.str(), depth: S.int(0), name: S.str() }, ['ok']),
})
