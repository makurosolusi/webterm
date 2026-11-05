// Builtin-claude launch lines from the launch profiles (against a possibly partial settings object),
// and recognition of the Claude nodes made before profiles existed. Pure: callers pass settings.
import { assembleCmd } from '../workspace'
import { DEFAULT_CLAUDE_PROFILE, resolveProfileLaunch, type ClaudeLaunchSettings, type ResolvedClaudeLaunch } from './claudeLaunch.profiles'
import { joinArgv } from './shellQuote'

/** Profile `profileId` (absent = the default profile) of `s`; missing profile fields mean Default. */
export function resolveClaudeProfileIn(s: Partial<ClaudeLaunchSettings>, profileId?: string): ResolvedClaudeLaunch {
  return resolveProfileLaunch({
    claudeLaunchProfiles: s.claudeLaunchProfiles ?? [],
    defaultClaudeProfileId: s.defaultClaudeProfileId ?? DEFAULT_CLAUDE_PROFILE.id,
    centralClaudeProfileId: s.centralClaudeProfileId ?? '',
  }, profileId)
}

/** Shell line of that profile for the PTY path (login shell): every argv token stays one argument. */
export const claudeProfileLine = (s: Partial<ClaudeLaunchSettings>, profileId?: string): string =>
  joinArgv(resolveClaudeProfileIn(s, profileId).argv)

/** The stock builtin claude command, as `assembleCmd` builds it without a user override. */
export const isBuiltinClaudeCmd = (cmd: string | undefined): boolean => cmd?.trim() === assembleCmd('claude')

/**
 * A builtin claude node from before launch profiles: no recorded profile and the stock command.
 * A customised command is never one, so it is never overridden by a profile.
 */
export const isLegacyClaudeNode = (n: { agentId?: string; cmd?: string; claudeProfileId?: string }): boolean =>
  n.agentId === 'claude' && !n.claudeProfileId && isBuiltinClaudeCmd(n.cmd)
