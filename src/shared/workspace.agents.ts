// Agent identity: which agents exist, how they look, and how they are launched and detected.
// Abilities (resume, context link, ...) live in workspace.capabilities.ts.

/** Claude Code is the only builtin harness. Other CLIs (codex, gemini, ...) are plain terminal
 *  programs: a stored node with such an `agentId` still launches its `cmd` untouched, and resolves
 *  like a custom agent without abilities (`agentConfig` returns undefined). */
export type BuiltinAgentId = 'claude'

/** Open on purpose: any string is a custom agent (convention `custom:<uuid>`; legacy `'custom'`
 *  stays valid). Never narrow this to a closed union, or custom agents and legacy stored nodes
 *  (`agentId: 'codex'`) stop type-checking. */
export type AgentId = BuiltinAgentId | (string & {})

/**
 * Lifecycle state of an agent session. `failed`: it never started or exited non-zero.
 * `stopped`: the user ended it (Stop/close) and it can be resumed. Only the server sets those two.
 */
export type AgentStatus = 'working' | 'waiting' | 'blocked' | 'done' | 'failed' | 'stopped'

export interface AgentConfig {
  /** Menu label and node title, e.g. 'Claude Code'. */
  label: string
  /** Node accent colour (hex). */
  color: string
  /** Base launch command. */
  launchCmd: string
  /** Process name expected in `ps`; used to detect whether the agent is running. */
  expectedProcess: string
}

/** Display order wherever agents are offered (menu, dock, settings). */
export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = ['claude']

export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: { label: 'Claude Code', color: '#d97757', launchCmd: 'claude', expectedProcess: 'claude' },
}

/** Older name for `AGENT_CONFIG`; new code should use that or `agentConfig(id)`. */
export const AGENTS = AGENT_CONFIG

/** Colour for custom or unknown agents that carry none of their own. */
export const FALLBACK_AGENT_COLOR = '#888888'

/** Builtin config for `id`, or undefined for custom/unknown agents. */
export const agentConfig = (id: AgentId): AgentConfig | undefined =>
  Object.hasOwn(AGENT_CONFIG, id) ? AGENT_CONFIG[id as BuiltinAgentId] : undefined

/** Type guard narrowing an open `AgentId` to a builtin, for call sites that only know builtin grammar. */
export const isBuiltinAgent = (id: AgentId): id is BuiltinAgentId => agentConfig(id) !== undefined
