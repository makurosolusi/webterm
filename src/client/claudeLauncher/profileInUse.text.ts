// Why the server kept a launch profile (HTTP 409 `profile_in_use`), as one sentence. Shared by the row's
// Delete and the list's Reset Setting (saved through useSettings), so both refusals read the same.
import type { ProfileInUse } from '../../shared/settings.patch'

/** The refusal sentence; `name` undefined = the profile is no longer in the local copy. */
export function profileInUseMessage(name: string | undefined, reason: ProfileInUse | string): string {
  const who = name === undefined ? 'A launch profile' : `"${name}"`
  if (reason === 'provider') return `${who} is the command the Claude provider runs (Custom command). Pick another command or mode there first.`
  if (reason === 'builtin') return 'The built-in Default cannot be deleted.'
  return `${who} is still in use.`
}

/** Names of launch profiles seen before an edit: a refused delete names one the optimistic copy already dropped. */
const knownNames = new Map<string, string>()
export function rememberProfileNames(list: readonly { id: string; name: string }[]): void {
  for (const p of list) knownNames.set(p.id, p.name)
}

/** The refusal as an Error for a 409 `profile_in_use` answer to PUT /api/settings, else null (body left unread). */
export async function profileInUseError(res: Response): Promise<Error | null> {
  if (res.status !== 409) return null
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown; profileId?: unknown; reason?: unknown } | null
  if (body?.error !== 'profile_in_use' || typeof body.reason !== 'string') return null
  return new Error(profileInUseMessage(knownNames.get(String(body.profileId)), body.reason))
}
