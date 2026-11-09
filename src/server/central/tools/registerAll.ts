// Registers the Central Agent v2 tool groups into one registry (WS-19). Every group is gated by its own
// flag at registration time, so with all flags off the registry (and `toolsHash`) is the core-only one.
import type { Database } from 'bun:sqlite'
import { flagOn } from '../../envFlag'
import { isEnabled } from '../../featureCapabilities.runtime'
import type { UserMemoryStore } from '../../memory/memoryUserStore'
import type { AgentExecutor } from '../agents/agentExecutor'
import type { MailDeliver } from '../agents/mailDeliver'
import { AGENT_MAIL_FLAG, createAgentRelayDef } from './defs/agent.relay.def'
import { AGENTS_FLAG, createAgentDefs } from './defs/agent.defs'
import { BROWSER_TOOLS_FLAG, createBrowserDefs } from './defs/browser.act'
import { CAP_DEFS } from './defs/cap.defs'
import type { BrowserToolDeps } from './defs/browser.status'
import { type ChannelBotDefDeps, createChannelBotDef } from './defs/channel.bot.def'
import { KNOWLEDGE_FLAG, createKnowledgeDefs } from './defs/kb.defs'
import { createRepoMapDef } from '../../knowledge/repoMap.def'
import { createMemoryDefs } from './defs/memory.defs'
import { BLACKBOARD_DEFS } from '../../blackboard/blackboard.defs'
import { createCanvasActDefs } from './defs/canvas.act.defs'
import { createCanvasShotDefs } from './defs/canvas.shot.def'
import { createCanvasViewDefs } from './defs/canvas.view.defs'
import { createNodeReadDefs } from './defs/read.node'
import { PROJECT_READ_DEFS } from './defs/read.project'
import { TASK_READ_DEFS } from './defs/read.task'
import { SKILLS_FLAG, type SkillStoreResolver, createSkillDefs } from './defs/skill.defs'
import { TASK_RUN_DEF } from './defs/task.run.def'
import { type ToolDef, type ToolRegistry, defEnabled } from './toolTypes'

export { toolsHash } from './toolRegistry'

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
  browser?: BrowserToolDeps
}

type Env = Record<string, string | undefined>
const on = (env: Env, name: string): boolean => flagOn(env[name])
const agentsOn = (env: Env): boolean => AGENT_MODES.includes((env[AGENTS_FLAG] ?? '').trim().toLowerCase())
// Loaded on first call, not at import: the board runtime opens webterm.db and `sessions` boots the PTY
// supervisor, neither of which a module that merely registers tools (or its tests) should trigger.
const nodeDefs = (): ToolDef[] => [
  ...createNodeReadDefs({
    live: async () => { const { sessions } = await import('../../sessions'); return (id) => sessions.isLive(id) },
    sessions: async () => (await import('../../sessions')).sessions,
    secrets: async () => (await import('../runtime/runtimeEvents')).brokerSecretValues(),
  }),
  ...createCanvasActDefs({ canvas: async () => (await import('../../canvas/canvasPush.runtime')).getCanvasPush(), browserOn: () => isEnabled('browser') }),
  ...createCanvasViewDefs({
    ui: async () => {
      const [{ db }, { broadcastUi }] = await Promise.all([import('../../db'), import('../../canvas/canvasPush.runtime')])
      return { setActive: (id) => db.setActive(id), broadcast: broadcastUi }
    },
  }),
  ...createCanvasShotDefs(),
]

/** Registers the groups whose flag is on and returns the names added (already-registered names are skipped). */
export function registerCa2Tools(registry: ToolRegistry, deps: Ca2ToolDeps, env: Env = process.env): string[] {
  // Read tools dan memori ikut `central` (turunan, ENVSIMPLE D5); env efektif dari boot sudah memuat kunci turunannya.
  const central = isEnabled('central', env)
  const groups: Array<[boolean, () => readonly ToolDef[]]> = [
    [central, () => [...CAP_DEFS, ...PROJECT_READ_DEFS, ...nodeDefs(), ...TASK_READ_DEFS]],
    [agentsOn(env) && !!deps.executor, () => createAgentDefs(deps.executor as AgentExecutor)],
    [agentsOn(env), () => [TASK_RUN_DEF]],
    [on(env, AGENT_MAIL_FLAG) && agentsOn(env), () => [createAgentRelayDef({ ...(deps.deliver ? { deliver: deps.deliver } : {}) })]],
    [on(env, KNOWLEDGE_FLAG) && !!deps.openKb, () => createKnowledgeDefs(deps.openKb as () => Database)],
    // repo.map keeps its own cache (repomap.db), so it needs no knowledge.db handle.
    [on(env, KNOWLEDGE_FLAG), () => [createRepoMapDef()]],
    [on(env, SKILLS_FLAG) && !!deps.skills, () => createSkillDefs(deps.skills as SkillStoreResolver)],
    [central, () => createMemoryDefs({ ...(deps.userStore ? { userStore: deps.userStore } : {}) })],
    // Shared blackboard (F5-b): read + propose; nodes see them through Central's MCP projection.
    [central, () => BLACKBOARD_DEFS],
    [on(env, BOTS_FLAG) && !!deps.bots, () => [createChannelBotDef(deps.bots as ChannelBotDefDeps)]],
    [on(env, BROWSER_TOOLS_FLAG) && !!deps.browser, () => createBrowserDefs(deps.browser as BrowserToolDeps)],
  ]
  const added: string[] = []
  for (const [enabled, build] of groups) {
    if (!enabled) continue
    for (const def of build()) {
      // Per-def flags (skill.propose, task.run) refine the group; a def without one follows its group.
      if (registry.get(def.name) || !defEnabled(def, env)) continue
      registry.register(def)
      added.push(def.name)
    }
  }
  return added
}
