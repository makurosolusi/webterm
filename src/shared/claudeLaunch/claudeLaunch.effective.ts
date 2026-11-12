// GET /api/claude-launch/effective: what new Claude agents, Central and helpers really start with, from
// the server's own resolver (claudeLauncher.ts), so Settings never recomputes it without the command-mode
// override. React-free and server-free: both sides read the shape.
export const CLAUDE_LAUNCH_EFFECTIVE_PATH = '/api/claude-launch/effective'

export interface LaunchTarget { profileId: string; name: string; command: string }

export interface EffectiveClaudeLaunch {
  /** New Claude agent nodes and background helpers. */
  agents: LaunchTarget
  /** `source`: 'default' = follows the agents' profile, 'central' = its own pick (Settings › Claude › Advanced). */
  central: LaunchTarget & { source: 'default' | 'central' }
  /** Where the credential comes from: the Connection card (key/endpoint), the user's command, the server env, or the Claude Code login. */
  credential: 'card' | 'command' | 'env' | 'login'
  /** Launches that differ from the agents' one (today only Central's own pick). */
  deviations: { who: 'central'; profileId: string; name: string }[]
}
