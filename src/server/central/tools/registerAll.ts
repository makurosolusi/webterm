// Registers the Central Agent v2 tool groups into one registry (WS-19). Every group is gated by its own
// flag at registration time, so with all flags off the registry (and `toolsHash`) is the core-only one.
import type { Database } from 'bun:sqlite'
import { flagOn } from '../../envFlag'
import type { UserMemoryStore } from '../../memory/memoryUserStore'
import type { AgentExecutor } from '../agents/agentExecutor'
import type { MailDeliver } from '../agents/mailDeliver'
import { AGENT_MAIL_FLAG, createAgentRelayDef } from './defs/agent.relay.def'
import { AGENTS_FLAG, createAgentDefs } from './defs/agent.defs'
import { type ChannelBotDefDeps, createChannelBotDef } from './defs/channel.bot.def'
import { KNOWLEDGE_FLAG, createKnowledgeDefs } from './defs/kb.defs'
import { createMemoryDefs } from './defs/memory.defs'
import { NODE_READ_DEFS } from './defs/read.node'
import { PROJECT_READ_DEFS } from './defs/read.project'
import { READ_TOOLS_FLAG } from './defs/read.shared'
import { TASK_READ_DEFS } from './defs/read.task'
import { SKILLS_FLAG, type SkillStoreResolver, createSkillDefs } from './defs/skill.defs'
import { TASK_RUN_DEF } from './defs/task.run.def'
import type { ToolDef, ToolRegistry } from './toolTypes'

export { toolsHash } from './toolRegistry'

const MEMORY_FLAG = 'WEBTERM_CENTRAL_MEMORY'
const BOTS_FLAG = 'WEBTERM_CENTRAL_BOTS'
const AGENT_MODES = ['propose', 'auto']

/** What each group needs from the process; a missing dependency skips its group instead of failing boot. */
export interface Ca2ToolDeps {
  executor?: AgentExecutor
  deliver?: MailDeliver
  openKb?: () => Database
  skills?: SkillStoreResolver
  userStore?: UserMemoryStore
  bots?: ChannelBotDefDeps
}

type Env = Record<string, string | undefined>
const on = (env: Env, name: string): boolean => flagOn(env[name])
const agentsOn = (env: Env): boolean => AGENT_MODES.includes((env[AGENTS_FLAG] ?? '').trim().toLowerCase())

/** Registers the groups whose flag is on and returns the names added (already-registered names are skipped). */
export function registerCa2Tools(registry: ToolRegistry, deps: Ca2ToolDeps, env: Env = process.env): string[] {
  const groups: Array<[boolean, () => readonly ToolDef[]]> = [
    [on(env, READ_TOOLS_FLAG), () => [...PROJECT_READ_DEFS, ...NODE_READ_DEFS, ...TASK_READ_DEFS]],
    [agentsOn(env) && !!deps.executor, () => createAgentDefs(deps.executor as AgentExecutor)],
    [agentsOn(env), () => [TASK_RUN_DEF]],
    [on(env, AGENT_MAIL_FLAG) && agentsOn(env), () => [createAgentRelayDef({ ...(deps.deliver ? { deliver: deps.deliver } : {}) })]],
    [on(env, KNOWLEDGE_FLAG) && !!deps.openKb, () => createKnowledgeDefs(deps.openKb as () => Database)],
    [on(env, SKILLS_FLAG) && !!deps.skills, () => createSkillDefs(deps.skills as SkillStoreResolver)],
    [on(env, MEMORY_FLAG), () => createMemoryDefs({ ...(deps.userStore ? { userStore: deps.userStore } : {}) })],
    [on(env, BOTS_FLAG) && !!deps.bots, () => [createChannelBotDef(deps.bots as ChannelBotDefDeps)]],
  ]
  const added: string[] = []
  for (const [enabled, build] of groups) {
    if (!enabled) continue
    for (const def of build()) {
      // Per-def flags (skill.propose, task.run) refine the group; a def without one follows its group.
      if (registry.get(def.name) || (def.flag && !on(env, def.flag))) continue
      registry.register(def)
      added.push(def.name)
    }
  }
  return added
}
