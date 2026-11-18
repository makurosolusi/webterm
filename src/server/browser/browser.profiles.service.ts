// Browser profile registry service: list/resolve/create/rename/recolor (no HTTP). The routes, the agent verb `open`
// and Central's tools all go through it. Process-bound parts (live, stop, copy, delete) live in browser.profiles.ops.ts.
import { randomBytes } from 'node:crypto'
import type { BrowserProfileStore, ProfileRow } from '../db.browserProfile'
import type { Workspace } from '../../shared/workspace'
import { BROWSER_KIND } from '../../shared/browser.contract'
import {
  BROWSER_PROFILE_NAME_MAX, isBrowserProfileId, matchProfileRef, profileNameKey, resolveProfileId, validateProfileName,
} from '../../shared/browser.profile'
import type { BrowserProfile, ProfileCreateReq, ProfileErrorCode, ProfileUpdateReq } from '../../shared/browser.profile'
import { DEFAULT_WORKSPACE_SHADE, backfillWorkspaceHue, isWorkspaceHue, isWorkspaceShade, pickWorkspaceColor } from '../../shared/workspaceColor'
import { createLogger } from '../logs'
import type { CookieVault } from './cookieVault.store'
import type { ProfileAccount } from '../../shared/browser.accounts'

const log = createLogger('browser.profiles')
const ID_PREFIX = 'bp-'
const ID_RANDOM_BYTES = 6

export type ProfileResult<T> = { ok: true; value: T } | { ok: false; code: ProfileErrorCode }
export const ok = <T>(value: T): ProfileResult<T> => ({ ok: true, value })
export const err = (code: ProfileErrorCode): ProfileResult<never> => ({ ok: false, code })

export interface ProfilesDeps {
  store: BrowserProfileStore
  workspaces(): Workspace[]
  vault: Pick<CookieVault, 'listDomains'>
  /** Profile ids of every browser node on every board (an unsaved UI profile switch already applied). */
  nodeProfileIds(): string[]
  /** A Chromium process runs on this profile. */
  isLive(id: string): boolean
  /** Signed-in accounts last seen for a profile (masked; [] = none known or the switch is off). */
  accounts?(id: string): ProfileAccount[]
  /** Tell every window the list changed. */
  changed(): void
  /** Bounded audit line for a change (ledger); `by` = who asked. */
  note?(text: string, by: ProfileActor): void
  rand?: () => number
  now?: () => number
}
/** Who asked: the human UI or an agent/Central (agents leave a ledger note, never a permission card). */
export type ProfileActor = 'human' | 'agent'

export interface ProfilesService {
  /** Create the Default profile (id = workspace id) of every board that lacks one; idempotent. */
  ensureDefaults(): void
  list(workspaceId?: string): BrowserProfile[]
  /** By id or case-insensitive name; `workspaceId` prefers that board's and global profiles. */
  resolve(ref: string, workspaceId?: string): BrowserProfile | undefined
  create(input: ProfileCreateReq, by?: ProfileActor): ProfileResult<BrowserProfile>
  update(id: string, patch: ProfileUpdateReq, by?: ProfileActor): ProfileResult<BrowserProfile>
  readonly deps: ProfilesDeps
}

export function createProfilesService(deps: ProfilesDeps): ProfilesService {
  const rand = deps.rand ?? Math.random
  const now = deps.now ?? Date.now
  const nameTaken = (name: string, exceptId?: string): boolean =>
    deps.store.list().some((r) => r.id !== exceptId && profileNameKey(r.name) === profileNameKey(name))

  function defaultName(w: Workspace): string {
    const base = `Default (${w.name}`.slice(0, BROWSER_PROFILE_NAME_MAX - 1) + ')'
    let name = base
    for (let n = 2; nameTaken(name); n++) name = `${base.slice(0, -1)} ${n})`.slice(0, BROWSER_PROFILE_NAME_MAX)
    return name
  }

  function view(r: ProfileRow, uses: Map<string, number>): BrowserProfile {
    let cookieDomains = 0
    try {
      cookieDomains = deps.vault.listDomains(r.id).length
    } catch (e) {
      // An unreadable vault must not hide the profile from the picker; the cause is logged by code only.
      log.warn('browser.profiles.vault', 'cookie vault unreadable for a profile', { ids: { profileId: r.id }, error: e instanceof Error ? e.name : typeof e })
    }
    const accounts = deps.accounts?.(r.id) ?? []
    return {
      id: r.id, name: r.name, color: r.color, shade: r.shade, createdAt: r.createdAt, workspaceId: r.workspaceId,
      ...(r.workspaceId === r.id ? { isDefaultOf: r.id } : {}),
      live: deps.isLive(r.id), nodeCount: uses.get(r.id) ?? 0, cookieDomains,
      ...(accounts.length > 0 ? { accounts } : {}),
    }
  }

  const usage = (): Map<string, number> => {
    const m = new Map<string, number>()
    for (const id of deps.nodeProfileIds()) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }

  const svc: ProfilesService = {
    deps,
    ensureDefaults() {
      let added = false
      for (const w of deps.workspaces()) {
        if (!isBrowserProfileId(w.id) || deps.store.get(w.id)) continue
        const color = isWorkspaceHue(w.color) ? w.color : backfillWorkspaceHue(w.id)
        added = deps.store.insert({ id: w.id, name: defaultName(w), color, shade: isWorkspaceShade(w.colorShade) ? w.colorShade : DEFAULT_WORKSPACE_SHADE, createdAt: now(), workspaceId: w.id }) || added
      }
      if (added) deps.changed()
    },
    list(workspaceId) {
      svc.ensureDefaults()
      const uses = usage()
      return deps.store.list().filter((r) => workspaceId === undefined || r.workspaceId === null || r.workspaceId === workspaceId).map((r) => view(r, uses))
    },
    resolve(ref, workspaceId) {
      return matchProfileRef(svc.list(), ref, workspaceId)
    },
    create(input, by = 'human') {
      const n = validateProfileName(input.name)
      if (!n.ok) return err(n.code)
      if (nameTaken(n.name)) return err('profile_name_taken')
      if (input.color !== undefined && !isWorkspaceHue(input.color)) return err('bad_request')
      if (input.shade !== undefined && !isWorkspaceShade(input.shade)) return err('bad_request')
      if (input.workspaceId !== undefined && !deps.workspaces().some((w) => w.id === input.workspaceId)) return err('bad_request')
      const used = deps.store.list().map((r) => r.color)
      const row: ProfileRow = {
        id: ID_PREFIX + randomBytes(ID_RANDOM_BYTES).toString('hex'), name: n.name,
        color: input.color ?? pickWorkspaceColor(used, rand), shade: input.shade ?? DEFAULT_WORKSPACE_SHADE,
        createdAt: now(), workspaceId: input.workspaceId ?? null,
      }
      if (!deps.store.insert(row)) return err('profile_name_taken')
      deps.note?.(`created browser profile "${row.name}"`, by)
      deps.changed()
      return ok(view(row, usage()))
    },
    update(id, patch, by = 'human') {
      const cur = deps.store.get(id)
      if (!cur) return err('profile_not_found')
      let name: string | undefined
      if (patch.name !== undefined) {
        const n = validateProfileName(patch.name)
        if (!n.ok) return err(n.code)
        if (nameTaken(n.name, id)) return err('profile_name_taken')
        name = n.name
      }
      if (patch.color !== undefined && !isWorkspaceHue(patch.color)) return err('bad_request')
      if (patch.shade !== undefined && !isWorkspaceShade(patch.shade)) return err('bad_request')
      if (!deps.store.update(id, { name, color: patch.color, shade: patch.shade })) return err('profile_name_taken')
      deps.note?.(`updated browser profile "${name ?? cur.name}"`, by)
      deps.changed()
      return ok(view(deps.store.get(id) as ProfileRow, usage()))
    },
  }
  return svc
}

/** Profile ids used by browser nodes: `override` (a switch the UI made that the board has not saved yet) wins over the stored field. */
export function nodeProfileIdsOf(workspaces: Workspace[], override: (nodeId: string) => string | undefined): string[] {
  return workspaces.flatMap((w) => w.nodes.filter((n) => n.kind === BROWSER_KIND).map((n) => override(n.id) ?? resolveProfileId(w.id, n)))
}

// Module-level handle, same pattern as `activeBrowser()`: the runtime registers its service, Central tools read it.
let active: ProfilesService | null = null
export const activeProfiles = (): ProfilesService | null => active
export const setActiveProfiles = (s: ProfilesService | null): void => { active = s }

/** Profiles for Central tools / the agent verb; empty when the browser runtime is off. */
export const listProfiles = (workspaceId?: string): BrowserProfile[] => active?.list(workspaceId) ?? []
/** Id-or-name lookup against the active registry. */
export const resolveProfile = (refOrName: string, workspaceId?: string): BrowserProfile | undefined => active?.resolve(refOrName, workspaceId)
/** Create a profile (`by: 'agent'` leaves a ledger note); `profile_not_found` when the browser runtime is off. */
export const createProfile = (input: ProfileCreateReq, by: ProfileActor = 'agent'): ProfileResult<BrowserProfile> =>
  active ? active.create(input, by) : err('profile_not_found')
