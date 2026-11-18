// One line naming the browser profiles an agent can use, for the agent prompt tails (Central's volatile tail, a chat's
// opening briefing). Custom profiles first (those are the accounts); a workspace Default only if there is room.
export const PROFILE_NAMES_MAX = 10

/** `Browser profiles: "work", "personal" +3 more. ...`; '' when there is no profile to name. */
export function renderProfileNames(profiles: ReadonlyArray<{ name: string; isDefaultOf?: string }>): string {
  if (profiles.length === 0) return ''
  const sorted = [...profiles.filter((p) => !p.isDefaultOf), ...profiles.filter((p) => p.isDefaultOf)]
  const shown = sorted.slice(0, PROFILE_NAMES_MAX).map((p) => `"${p.name}"`).join(', ')
  const more = sorted.length > PROFILE_NAMES_MAX ? ` +${sorted.length - PROFILE_NAMES_MAX} more` : ''
  return `Browser profiles: ${shown}${more}. Pass a name as the profile; none = the board's Default.`
}
