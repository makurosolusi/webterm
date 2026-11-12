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
import type { EffectiveClaudeLaunch, LaunchTarget } from '../../shared/claudeLaunch/claudeLaunch.effective'

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

/**
 * Stored settings with the command-mode profile (if it still exists) as the default; '' Central follows it.
 * A stored default whose profile is gone (old data) reads as Default, where it launches anyway, so the
 * default itself never reports a missing profile. Only an explicit id can be missing.
 */
function effective(): ClaudeLaunchSettings {
  const s = read()
  const stored = claudeProfiles(s).some((p) => p.id === s.defaultClaudeProfileId) ? s.defaultClaudeProfileId : DEFAULT_CLAUDE_PROFILE.id
  const id = liveOverride(s) ?? stored
  return id === s.defaultClaudeProfileId ? s : { ...s, defaultClaudeProfileId: id }
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

/** Agents' and Central's launch as the server resolves it (the command-mode override included). */
export function effectiveLaunchTargets(): Pick<EffectiveClaudeLaunch, 'agents' | 'central' | 'deviations'> {
  const target = (r: ResolvedClaudeLaunch): LaunchTarget => ({ profileId: r.profile.id, name: r.profile.name, command: joinArgv(r.argv) })
  const agents = target(resolveClaudeLaunch())
  const central = target(centralClaudeLaunch())
  const own = read().centralClaudeProfileId !== '' && central.profileId !== agents.profileId
  return {
    agents,
    central: { ...central, source: own ? 'central' : 'default' },
    deviations: own ? [{ who: 'central', profileId: central.profileId, name: central.name }] : [],
  }
}

/** All profiles, Default first (for listings). */
export const listClaudeProfiles = (): ClaudeLaunchProfile[] => claudeProfiles(read())

/** Shell line for the PTY path (which runs through a login shell): every token stays one argument. */
export const claudeLaunchLine = (r: ResolvedClaudeLaunch): string => joinArgv(r.argv)

const MAX_PROFILE_ID = 64

/** Terminal note for a node whose recorded profile was deleted (id/name never printed: user text). */
export const missingProfileNotice = (fallback: string): string =>
  `\r\n[webterm] This node's Claude launch profile no longer exists — launching with "${fallback}". Pick another in Settings › Claude.\r\n`

/**
 * The launch of a node (terminal or Agent Chat) that recorded `profileId`. The client records the settings
 * default as the node's profile at creation, so an id equal to the STORED default (even one whose profile is
 * gone) is "no conscious pick" and resolves like the default: command mode, else the stored default, else
 * Default, never missing. Ceiling: a node deliberately set to that same profile is indistinguishable and
 * follows it too. Any other id is explicit: it keeps its profile, or is `missingId` once deleted.
 */
export function nodeClaudeLaunch(profileId?: string): ResolvedClaudeLaunch {
  // While command mode is on, a node that recorded Default was made before saving command mode also set the
  // stored default (claudeProvider.api.ts): it followed the command then and still does.
  const followsDefault = profileId === read().defaultClaudeProfileId || (profileId === DEFAULT_CLAUDE_PROFILE.id && liveOverride(read()) !== undefined)
  return resolveClaudeLaunch(followsDefault ? undefined : profileId)
}

/**
 * Builtin claude node with a recorded `claudeProfileId`: its launch command comes from the profile
 * (the client's `cmd` is ignored), so profile edits reach the next launch and cold restore. A deleted
 * explicit profile falls back to Default with a visible notice (`nodeClaudeLaunch`). Other nodes pass through untouched.
 */
export function applyNodeClaudeProfile<M extends { agentId?: string; cmd?: string; claudeProfileId?: string }>(msg: M): { msg: M; notice?: string } {
  const id = msg.claudeProfileId
  if (msg.agentId !== 'claude' || typeof id !== 'string' || id === '' || id.length > MAX_PROFILE_ID) return { msg }
  const r = nodeClaudeLaunch(id)
  return { msg: { ...msg, cmd: claudeLaunchLine(r) }, ...(r.missingId ? { notice: missingProfileNotice(r.profile.name) } : {}) }
}
