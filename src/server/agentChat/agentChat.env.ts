// Child environment of an agent chat Claude process (PLAN/AGENT-CHAT.md D9). The SDK's `env` option
// REPLACES the child env (sdk.d.ts), so this is the whole env, built like a terminal agent's PTY env
// so the chat node authenticates exactly like a terminal agent in the same workspace:
//  - base = `ptyEnv(parent, {interactive:false})` (what `spawnPty`/the tmux supervisor give an agent
//    command): the parent env incl. ANTHROPIC_* / CLAUDE_CODE_* auth+model vars, minus server-only
//    vars (WEBTERM_* root token, legacy NODETERM_*, PORT, ...).
//  - the active Claude provider (`applyProviderEnv`, what the terminal's one-shot launch file does).
//  - the node identity `sessions.ts open` injects: header file path (never the token value),
//    WEBTERM_NODE_ID/PORT, webterm bin on PATH.
// Differences from the terminal, on purpose: TMUX/TMUX_PANE dropped (the tmux supervisor drops them
// too), CLAUDECODE dropped (nested-session guard), capability-token values (`wcap_`) dropped.
import { applyProviderEnv, type ProviderEnv } from '../claudeProvider/claudeProvider.model'
import { activeProviderEnv } from '../claudeProvider/claudeProvider.store'
import { claudeHeadersPath } from '../hooksPaths'
import { NODE_HEADERS_ENV } from '../hooksTokens'
import { ptyEnv } from '../ptyShell'
import { agentPath } from '../sessions'

/** Keys a terminal agent may inherit that a chat child must not get. */
export const AGENT_CHAT_DROPPED_ENV = ['CLAUDECODE', 'TMUX', 'TMUX_PANE'] as const
const CAPABILITY_TOKEN_PREFIX = 'wcap_'

/** Whole child env for node `nodeId`: terminal-agent base + provider + profile env + node identity. */
export function agentChatEnv(i: {
  nodeId: string; port: number; profileEnv?: Record<string, string>; parentEnv?: NodeJS.ProcessEnv; provider?: ProviderEnv
}): Record<string, string> {
  const parent = i.parentEnv ?? process.env
  const base = ptyEnv(parent, { interactive: false })
  for (const k of AGENT_CHAT_DROPPED_ENV) delete base[k]
  for (const [k, v] of Object.entries(base)) if (v.startsWith(CAPABILITY_TOKEN_PREFIX)) delete base[k]
  const env: Record<string, string> = {
    ...applyProviderEnv(base, i.provider ?? activeProviderEnv()),
    ...i.profileEnv,
    [NODE_HEADERS_ENV]: claudeHeadersPath(i.nodeId),
    WEBTERM_NODE_ID: i.nodeId,
    WEBTERM_PORT: String(i.port),
    PATH: agentPath(parent.PATH ?? ''),
  }
  delete env.CLAUDECODE
  return env
}
