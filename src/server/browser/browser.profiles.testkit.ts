// Test rig for the profile registry: in-memory store, real cookie vault + dirs under a temp data root, fake processes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { createMemoryProfileStore } from '../db.browserProfile'
import { createCookieVault } from './cookieVault.store'
import { createProfilesService } from './browser.profiles.service'
import type { ProfilesService } from './browser.profiles.service'
import type { ProfileOpsDeps } from './browser.profiles.ops'
import type { BrowserCookie } from './cookieImport.parse'

export const ws = (id: string, name: string, nodes: Workspace['nodes'] = []): Workspace =>
  ({ id, name, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges: [], nodes })

export const cookie = (domain: string, name = 'sid', value = 'v'): BrowserCookie =>
  ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true })

export interface Rig {
  base: string
  boards: Workspace[]
  live: Set<string>
  stopped: string[]
  changes: number
  notes: string[]
  svc: ProfilesService
  ops: ProfileOpsDeps
  vault: ReturnType<typeof createCookieVault>
}

/** Rig with a deterministic `rand` (0 = first free hue) and a switchable live set. */
export function makeRig(boards: Workspace[] = [ws('w1', 'Alpha'), ws('w2', 'Beta')]): Rig {
  const secrets = new Map<string, string>()
  const base = mkdtempSync(join(tmpdir(), 'bprof-'))
  const vault = createCookieVault({ secrets: { read: (k) => secrets.get(k) ?? null, write: (k, v) => void secrets.set(k, v), remove: (k) => void secrets.delete(k) }, baseDir: base })
  const rig = { base, boards, live: new Set<string>(), stopped: [] as string[], changes: 0, notes: [] as string[], vault } as Rig
  rig.svc = createProfilesService({
    store: createMemoryProfileStore(), workspaces: () => rig.boards, vault,
    nodeProfileIds: () => rig.boards.flatMap((w) => w.nodes.filter((n) => n.kind === 'browser').map((n) => n.profileId ?? w.id)),
    isLive: (id) => rig.live.has(id), changed: () => { rig.changes++ }, note: (t, by) => { rig.notes.push(`${by}:${t}`) }, rand: () => 0,
  })
  rig.ops = { svc: rig.svc, vault, dataRoot: base, stop: (id) => { rig.stopped.push(id) } }
  return rig
}
