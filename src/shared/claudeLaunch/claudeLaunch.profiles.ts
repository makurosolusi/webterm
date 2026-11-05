// Claude launch profiles: stored list, the built-in Default, the agentLaunchCommands seed, and
// resolution of a profile id to argv. Pure (no settings store): callers pass the settings slice.
import { normalizeClaudeCommand, splitLaunch } from './claudeLaunch.normalize'

export interface ClaudeLaunchProfile { id: string; name: string; command: string }

/** Always present, never stored, never deletable. */
export const DEFAULT_CLAUDE_PROFILE: Readonly<ClaudeLaunchProfile> = { id: 'default', name: 'Default', command: 'claude' }
/** Id the agentLaunchCommands.claude seed gets (deterministic, so re-seeding is idempotent). */
export const SEEDED_PROFILE_ID = 'custom'
export const CLAUDE_PROFILE_LIMITS = { count: 50, id: 64, name: 80, command: 2000 }

export interface ClaudeLaunchSettings {
  claudeLaunchProfiles: ClaudeLaunchProfile[]
  defaultClaudeProfileId: string
  /** '' = same as `defaultClaudeProfileId`. */
  centralClaudeProfileId: string
}

/** Keep well-formed, unique, size-capped profiles; the reserved Default id is dropped. */
export function normalizeClaudeProfiles(v: unknown): ClaudeLaunchProfile[] {
  if (!Array.isArray(v)) return []
  const out: ClaudeLaunchProfile[] = []
  const L = CLAUDE_PROFILE_LIMITS
  for (const p of v) {
    if (out.length >= L.count) break
    if (!p || typeof p !== 'object') continue
    const { id, name, command } = p as Record<string, unknown>
    if (typeof id !== 'string' || !id || id.length > L.id || id === DEFAULT_CLAUDE_PROFILE.id) continue
    if (typeof name !== 'string' || name.length > L.name) continue
    if (typeof command !== 'string' || command.length > L.command) continue
    if (out.some((o) => o.id === id)) continue
    out.push({ id, name: name.trim() || id, command })
  }
  return out
}

/**
 * Migration (load-time, no schema change): a stored `agentLaunchCommands.claude` from before
 * profiles existed becomes a profile named "Custom" and the default. It runs only while
 * `claudeLaunchProfiles` was never stored; the first save persists the result, so it happens once.
 */
export function seedClaudeProfiles(saved: Record<string, unknown>, legacyClaude: string | undefined): Partial<ClaudeLaunchSettings> {
  if (saved.claudeLaunchProfiles !== undefined) return {}
  const command = legacyClaude?.trim()
  if (!command) return {}
  return {
    claudeLaunchProfiles: [{ id: SEEDED_PROFILE_ID, name: 'Custom', command }],
    ...(typeof saved.defaultClaudeProfileId === 'string' ? {} : { defaultClaudeProfileId: SEEDED_PROFILE_ID }),
  }
}

/** Default first, then the user's profiles. */
export const claudeProfiles = (s: ClaudeLaunchSettings): ClaudeLaunchProfile[] => [DEFAULT_CLAUDE_PROFILE, ...s.claudeLaunchProfiles]

/** Profile Central uses. */
export const centralProfileId = (s: ClaudeLaunchSettings): string => s.centralClaudeProfileId || s.defaultClaudeProfileId

export interface ResolvedClaudeLaunch {
  /** Full argv: wrapper + claude + the profile's claude flags. */
  argv: string[]
  profile: ClaudeLaunchProfile
  /** Id that was asked for but no longer exists (fell back to Default). */
  missingId?: string
  wrapper: string[]
  bin: string
  flags: string[]
  warnings: string[]
}

/** Resolve `profileId` (absent/'' = the default profile). An unknown id falls back to Default. */
export function resolveProfileLaunch(s: ClaudeLaunchSettings, profileId?: string): ResolvedClaudeLaunch {
  const wanted = profileId || s.defaultClaudeProfileId || DEFAULT_CLAUDE_PROFILE.id
  const found = claudeProfiles(s).find((p) => p.id === wanted)
  const profile = found ?? DEFAULT_CLAUDE_PROFILE
  const n = normalizeClaudeCommand(profile.command)
  return { argv: n.argv, profile, ...(found ? {} : { missingId: wanted }), ...splitLaunch(n.argv), warnings: n.warnings }
}
