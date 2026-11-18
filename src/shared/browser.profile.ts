// Browser profile contract (types + pure validators), shared by server, client API and Central tools.
// A profile is a persistent Chromium user-data dir + cookie vault. Nodes on the SAME profile share one
// Chromium process and session; different profiles never share anything. A node without a profile uses the
// Default profile of its workspace, whose id IS the workspace id (so every login made before profiles existed stays).

import type { ProfileAccount } from './browser.accounts'

export const BROWSER_PROFILE_NAME_MAX = 40
export const BROWSER_PROFILES_PATH = '/api/browser/profiles'
/** Frame the server broadcasts when the profile list or a profile's live state changes (clients refetch the list). */
export const BROWSER_PROFILES_EVENT = 'browserProfiles'
/** Ids that would collide with a `/api/browser/<segment>` route. */
const RESERVED_IDS: readonly string[] = ['profiles', 'status']
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface BrowserProfile {
  id: string
  name: string
  /** Palette hue id (workspaceColor.ts). */
  color: string
  shade: string
  createdAt: number
  /** Workspace this profile belongs to; null = global (usable from every board). */
  workspaceId: string | null
  /** Set (to the workspace id) on a workspace's Default profile; it cannot be deleted while the workspace exists. */
  isDefaultOf?: string
  /** A Chromium process currently runs on this profile. */
  live: boolean
  /** Browser nodes on any board that use this profile. */
  nodeCount: number
  /** Cookie domains saved in the profile's vault (never values). */
  cookieDomains: number
  /** Who is signed in (Google, GitHub), masked; absent while unchecked or when the Settings switch is off. */
  accounts?: ProfileAccount[]
}

export const PROFILE_ERROR_CODES = [
  'profile_not_found', 'profile_name_taken', 'profile_name_invalid', 'profile_in_use', 'profile_live',
  'profile_default', 'bad_request', 'cookie_import_disabled', 'cookie_import_invalid', 'cookie_import_empty',
] as const
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number]

export interface ProfileListResp { profiles: BrowserProfile[] }
export interface ProfileCreateReq { name: string; color?: string; shade?: string; workspaceId?: string }
export interface ProfileUpdateReq { name?: string; color?: string; shade?: string }
export interface ProfileDuplicateReq { name: string }
/** Cookie import result: counts only; the skipped reasons are codes, never cookie names or values. */
export interface ProfileImportResp { imported: number; skipped: number; reasons: string[]; domains: string[] }

/** True when `id` can be one path segment and does not shadow an API route. */
export function isBrowserProfileId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_PROFILE_ID.test(id) && !RESERVED_IDS.includes(id)
}

/** Trimmed name, or the error code naming what is wrong (empty / too long / control characters). */
export function validateProfileName(raw: unknown): { ok: true; name: string } | { ok: false; code: 'profile_name_invalid' } {
  if (typeof raw !== 'string') return { ok: false, code: 'profile_name_invalid' }
  const name = raw.trim()
  // eslint-disable-next-line no-control-regex -- a name is shown in tabs and the ledger: no control characters
  if (name === '' || name.length > BROWSER_PROFILE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, code: 'profile_name_invalid' }
  return { ok: true, name }
}

/** Names are unique ignoring case and surrounding space. */
export const profileNameKey = (name: string): string => name.trim().toLowerCase()

/** The one rule for which profile a browser node uses: its own `profileId`, else its workspace's Default. */
export function resolveProfileId(workspaceId: string, node?: { profileId?: string } | null): string {
  return isBrowserProfileId(node?.profileId) ? node.profileId : workspaceId
}

/** Find a profile by id or by name (case-insensitive); a global or same-workspace profile wins over another board's. */
export function matchProfileRef(profiles: readonly BrowserProfile[], ref: string, workspaceId?: string): BrowserProfile | undefined {
  const wanted = ref.trim()
  const visible = profiles.filter((p) => p.workspaceId === null || workspaceId === undefined || p.workspaceId === workspaceId)
  return visible.find((p) => p.id === wanted) ?? visible.find((p) => profileNameKey(p.name) === profileNameKey(wanted))
    ?? profiles.find((p) => p.id === wanted)
}
