// Profile operations that touch disk or processes: delete, duplicate, export. The registry rules (names, colors,
// ids) stay in browser.profiles.service.ts. Cookie values pass through here but are never logged or echoed.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import type { BrowserProfile } from '../../shared/browser.profile'
import { profileDir } from './profile.paths'
import type { CookieVault } from './cookieVault.store'
import { err, ok } from './browser.profiles.service'
import type { ProfileActor, ProfileResult, ProfilesService } from './browser.profiles.service'
import { createLogger } from '../logs'

const log = createLogger('browser.profiles')
/** Per-process leftovers of a running Chromium: copying them makes the copy believe another process owns it. */
const RUNTIME_FILES = /^(Singleton(Lock|Cookie|Socket)|DevToolsActivePort|lockfile)$/

export interface ProfileOpsDeps {
  svc: ProfilesService
  vault: Pick<CookieVault, 'load' | 'save' | 'clear' | 'listDomains'>
  dataRoot: string
  /** Stop the Chromium process of this profile (its nodes' pages become `discarded`, session stays on disk). */
  stop(id: string): void
}

/** Delete: refused while a node uses it, and for a Default profile whose workspace still exists. Stops its process, wipes dir + vault. */
export function removeProfile(o: ProfileOpsDeps, id: string, by: ProfileActor = 'human'): ProfileResult<null> {
  const { store } = o.svc.deps
  const row = store.get(id)
  if (!row) return err('profile_not_found')
  if (row.workspaceId === id && o.svc.deps.workspaces().some((w) => w.id === id)) return err('profile_default')
  const view = o.svc.list().find((p) => p.id === id)
  if (view && view.nodeCount > 0) return err('profile_in_use')
  o.stop(id)
  rmSync(profileDir(id, o.dataRoot), { recursive: true, force: true })
  o.vault.clear(id)
  store.remove(id)
  o.svc.deps.note?.(`deleted browser profile "${row.name}"`, by)
  o.svc.deps.changed()
  return ok(null)
}

/** Copy dir + vault into a new standalone profile (new id, vault re-encrypted under it); refused while the source runs. */
export function duplicateProfile(o: ProfileOpsDeps, id: string, name: unknown, by: ProfileActor = 'human'): ProfileResult<BrowserProfile> {
  const src = o.svc.deps.store.get(id)
  if (!src) return err('profile_not_found')
  if (o.svc.deps.isLive(id)) return err('profile_live')
  const made = o.svc.create({ name: name as string, color: src.color, shade: src.shade, ...(src.workspaceId === id ? {} : src.workspaceId ? { workspaceId: src.workspaceId } : {}) }, by)
  if (!made.ok) return made
  const to = made.value.id
  try {
    const from = profileDir(id, o.dataRoot)
    if (existsSync(from)) cpSync(from, profileDir(to, o.dataRoot), { recursive: true, filter: (p) => !RUNTIME_FILES.test(basename(p)) })
    const cookies = o.vault.load(id)
    if (cookies.length > 0) o.vault.save(to, cookies)
  } catch (e) {
    // Half a copy is worse than none: drop the new profile and tell the caller with the operation + ids.
    rmSync(profileDir(to, o.dataRoot), { recursive: true, force: true })
    o.vault.clear(to)
    o.svc.deps.store.remove(to)
    o.svc.deps.changed()
    throw new Error(`duplicate browser profile ${id} -> ${to} failed: ${e instanceof Error ? e.name : typeof e}`, { cause: e })
  }
  log.info('browser.profiles.duplicate', 'browser profile duplicated', { ids: { profileId: id }, copyId: to })
  return ok(made.value)
}

/** Cookie vault as a Playwright `storageState` JSON string: the same shape the importer parses back (round trip). Human-only (route gate). */
export function exportCookies(o: ProfileOpsDeps, id: string): ProfileResult<string> {
  if (!o.svc.deps.store.get(id)) return err('profile_not_found')
  return ok(JSON.stringify({ cookies: o.vault.load(id), origins: [] }))
}
