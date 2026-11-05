// THE source of truth for how webterm starts Claude: a profile id -> argv. Every Claude launch
// (agent nodes, Central, helpers) should build its argv here instead of spelling `claude`.
// The settings reader is registered by db.ts (like registerAgentBaseResolver) so importing this
// module never opens the database; unregistered = defaults = bare `claude`.
import { DEFAULT_SETTINGS } from '../../shared/settings'
import {
  DEFAULT_CLAUDE_PROFILE, centralProfileId, claudeProfiles, resolveProfileLaunch,
  type ClaudeLaunchProfile, type ClaudeLaunchSettings, type ResolvedClaudeLaunch,
} from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { joinArgv } from '../../shared/claudeLaunch/shellQuote'

export type { ClaudeLaunchProfile, ResolvedClaudeLaunch }
export { DEFAULT_CLAUDE_PROFILE }

let read: () => ClaudeLaunchSettings = () => DEFAULT_SETTINGS

/** Wire the settings store (db.ts). Tests may pass their own reader. */
export function registerClaudeLaunchSettings(reader: () => ClaudeLaunchSettings): void {
  read = reader
}

/** Profile `profileId` (absent = the default for new agents) as argv; unknown ids fall back to Default. */
export function resolveClaudeLaunch(profileId?: string): ResolvedClaudeLaunch {
  return resolveProfileLaunch(read(), profileId)
}

/** Launcher argv with claude's `args` appended, e.g. `claudeCommand(['-p', prompt])`. */
export function claudeCommand(args: readonly string[], profileId?: string): string[] {
  return [...resolveClaudeLaunch(profileId).argv, ...args]
}

/** The profile Central (and its preflight) uses. */
export function centralClaudeLaunch(): ResolvedClaudeLaunch {
  return resolveClaudeLaunch(centralProfileId(read()))
}

/** All profiles, Default first (for listings). */
export const listClaudeProfiles = (): ClaudeLaunchProfile[] => claudeProfiles(read())

/** Shell line for the PTY path (which runs through a login shell): every token stays one argument. */
export const claudeLaunchLine = (r: ResolvedClaudeLaunch): string => joinArgv(r.argv)

const MAX_PROFILE_ID = 64

/** Terminal note for a node whose recorded profile was deleted (id/name never printed: user text). */
export const missingProfileNotice = (fallback: string): string =>
  `\r\n[webterm] This node's Claude launch profile no longer exists — launching with "${fallback}". Pick another in Settings › Agent › Claude launch profiles.\r\n`

/**
 * Builtin claude node with a recorded `claudeProfileId`: its launch command comes from the profile
 * (the client's `cmd` is ignored), so profile edits reach the next launch and cold restore. An
 * unknown id falls back to Default with a visible notice. Other nodes pass through untouched.
 */
export function applyNodeClaudeProfile<M extends { agentId?: string; cmd?: string; claudeProfileId?: string }>(msg: M): { msg: M; notice?: string } {
  const id = msg.claudeProfileId
  if (msg.agentId !== 'claude' || typeof id !== 'string' || id === '' || id.length > MAX_PROFILE_ID) return { msg }
  const r = resolveClaudeLaunch(id)
  return { msg: { ...msg, cmd: claudeLaunchLine(r) }, ...(r.missingId ? { notice: missingProfileNotice(r.profile.name) } : {}) }
}
