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

let defaultOverride: () => string | undefined = () => undefined

/**
 * Wire the Claude provider's command mode (db.ts): while it names an existing profile, that profile is
 * the default for new agent nodes, Central and background helpers. An explicit profile id still wins.
 */
export function registerDefaultProfileOverride(reader: () => string | undefined): void {
  defaultOverride = reader
}

/** The command-mode profile id while that profile still exists, else undefined. */
function liveOverride(s: ClaudeLaunchSettings): string | undefined {
  const id = defaultOverride()
  return id && claudeProfiles(s).some((p) => p.id === id) ? id : undefined
}

/** Stored settings with the command-mode profile (if it still exists) as the default; '' Central follows it. */
function effective(): ClaudeLaunchSettings {
  const s = read()
  const id = liveOverride(s)
  return id ? { ...s, defaultClaudeProfileId: id } : s
}

/** Profile `profileId` (absent = the default for new agents) as argv; unknown ids fall back to Default. */
export function resolveClaudeLaunch(profileId?: string): ResolvedClaudeLaunch {
  return resolveProfileLaunch(effective(), profileId)
}

/** Launcher argv with claude's `args` appended, e.g. `claudeCommand(['-p', prompt])`. */
export function claudeCommand(args: readonly string[], profileId?: string): string[] {
  return [...resolveClaudeLaunch(profileId).argv, ...args]
}

/** The profile Central (and its preflight) uses. */
export function centralClaudeLaunch(): ResolvedClaudeLaunch {
  return resolveClaudeLaunch(centralProfileId(effective()))
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
 * unknown id falls back to Default with a visible notice (a deleted node profile keeps that notice). Other nodes pass through untouched.
 */
export function applyNodeClaudeProfile<M extends { agentId?: string; cmd?: string; claudeProfileId?: string }>(msg: M): { msg: M; notice?: string } {
  const id = msg.claudeProfileId
  if (msg.agentId !== 'claude' || typeof id !== 'string' || id === '' || id.length > MAX_PROFILE_ID) return { msg }
  // The client records the settings default as the node's profile at creation, so an id equal to the stored
  // default is "no conscious pick" and follows command mode. Ceiling: a node deliberately set to that same
  // profile is indistinguishable and follows it too. Any other id is explicit and keeps its profile.
  const s = read()
  const r = resolveClaudeLaunch(id === s.defaultClaudeProfileId ? liveOverride(s) ?? id : id)
  return { msg: { ...msg, cmd: claudeLaunchLine(r) }, ...(r.missingId ? { notice: missingProfileNotice(r.profile.name) } : {}) }
}
