export type AgentId = 'claude' | 'codex' | 'gemini' | 'custom'

export type AgentStatus = 'working' | 'waiting' | 'blocked' | 'done'

export interface AgentConfig { label: string; color: string; launchCmd: string }

// Built-in agents (custom is handled by a free-text command, not in this map).
export const AGENTS: Record<Exclude<AgentId, 'custom'>, AgentConfig> = {
  claude: { label: 'Claude', color: '#d97757', launchCmd: 'claude' },
  codex:  { label: 'Codex',  color: '#10a37f', launchCmd: 'codex' },
  gemini: { label: 'Gemini', color: '#4285f4', launchCmd: 'gemini' },
}

export interface Viewport { x: number; y: number; zoom: number }

export interface WsNode {
  id: string
  kind: 'terminal' | 'agent'
  x: number
  y: number
  title?: string
  cwd?: string            // falls back to the workspace cwd when absent
  cmd?: string            // agent launch line, e.g. "envman -e malik-opus -- claude"
  agentId?: AgentId
  color?: string
  sessionId?: string      // UUID pre-set at launch (claude --session-id); enables --resume
}

export interface Workspace {
  id: string
  name: string
  cwd?: string
  color?: string
  viewport: Viewport
  nodes: WsNode[]
  updatedAt: number
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

// Build an agent launch command line. envman profile is optional; when given,
// wrap the agent's base command as `envman -e <profile> -- <launchCmd>`.
// The command is later run via the login shell, so a plain string is correct —
// do NOT pre-split into argv.
export function assembleCmd(agentId: Exclude<AgentId, 'custom'>, profile?: string): string {
  const base = AGENTS[agentId].launchCmd
  return profile ? `envman -e ${profile} -- ${base}` : base
}
