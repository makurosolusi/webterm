// Downloaded files of one webterm data dir: `<root>/downloads/<profileId>/` (dir 0700, files 0600) plus a small `index.json`
// of metadata per profile. Chromium writes `<guid>` there (Browser.setDownloadBehavior allowAndName); when a download ends the
// file is renamed to its safe, unique name here. Not the workspace SQLite on purpose: history is disposable and per profile.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createLogger } from '../logs'
import { DOWNLOAD_PROFILE_QUOTA_BYTES, DOWNLOAD_RETENTION_MS, reduceDownloads, settleAfterRestart } from '../../shared/browser.downloads'
import type { DownloadEvent, DownloadItem } from '../../shared/browser.downloads'
import { sanitizeDownloadName, uniqueDownloadName } from '../../shared/browser.downloads.name'
import { isSafeWorkspaceId } from './profile.paths'

const log = createLogger('browser.downloads')
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const INDEX = 'index.json'
const GUID = /^[A-Za-z0-9-]{1,64}$/
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface DownloadStore {
  /** Folder of one profile (created 0700); throws on an unsafe profile id. */
  dir(profileId: string): string
  /** Load a profile's list from disk once (running entries become failed, vanished files `missing`); later calls hit memory. */
  items(profileId: string): DownloadItem[]
  /** Fold an event into the profile's list and persist it (progress is not persisted: only its end is). */
  apply(profileId: string, ev: DownloadEvent): DownloadItem[]
  /** Profile that holds a download id (among the loaded profiles), or undefined. */
  profileOf(id: string): string | undefined
  /** Absolute path of an item's file, always inside the profile folder: the final name when finished, else the guid file. */
  pathOf(profileId: string, item: DownloadItem): string
  /** Rename `<guid>` to the item's final unique name; returns that name. */
  finalize(profileId: string, id: string, suggested: string): string
  /** Delete the file of an item (any state); a missing file is fine. */
  deleteFile(profileId: string, item: DownloadItem): void
  /** Bytes of finished files in the profile. */
  used(profileId: string): number
  /** Drop expired entries, then oldest finished ones until `need` more bytes fit; false = it still does not fit. */
  makeRoom(profileId: string, need: number, now: number): boolean
  /** Remove expired entries (file and entry) of every loaded profile. */
  sweep(now: number): void
}

/** True when `target` is strictly below `root`. */
function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createDownloadStore(opts: { root: string; now?: () => number; max?: number; quota?: number; retentionMs?: number }): DownloadStore {
  const base = join(opts.root, 'downloads')
  const quota = opts.quota ?? DOWNLOAD_PROFILE_QUOTA_BYTES
  const retention = opts.retentionMs ?? DOWNLOAD_RETENTION_MS
  const lists = new Map<string, DownloadItem[]>()
  const now0 = (): number => (opts.now ?? Date.now)()

  const dir = (profileId: string): string => {
    if (!isSafeWorkspaceId(profileId)) throw new Error('downloads: invalid profile id')
    const d = join(base, profileId)
    if (!existsSync(d)) { mkdirSync(d, { recursive: true, mode: DIR_MODE }); chmodSync(base, DIR_MODE); chmodSync(d, DIR_MODE) }
    return d
  }
  const within = (d: string, leaf: string, id: string): string => {
    const p = join(d, leaf)
    if (!inside(d, p) || leaf.includes('/') || leaf.includes(sep) || leaf.includes('\\')) throw new Error(`downloads: path of ${id} escapes its profile folder`)
    return p
  }
  const pathOf = (profileId: string, item: DownloadItem): string => {
    const finished = item.state === 'completed' || item.state === 'missing'
    if (!finished && !GUID.test(item.id)) throw new Error('downloads: invalid download id')
    return within(dir(profileId), finished ? item.name : item.id, item.id)
  }
  const persist = (profileId: string): void => {
    const file = join(dir(profileId), INDEX)
    try {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(lists.get(profileId) ?? []), { mode: FILE_MODE })
      renameSync(tmp, file)
    } catch (err) {
      log.warn('downloads.index', 'could not save the download index', { ids: { profileId }, error: errMsg(err) })
    }
  }
  const rmFile = (profileId: string, item: DownloadItem): void => {
    try {
      const p = pathOf(profileId, item)
      rmSync(p, { force: true })
      if (item.state !== 'completed') rmSync(`${p}.crdownload`, { force: true }) // a canceled download may leave Chromium's partial file
    } catch (err) {
      log.warn('downloads.rm', 'could not delete a download file', { ids: { profileId }, error: errMsg(err) })
    }
  }
  const load = (profileId: string): DownloadItem[] => {
    const cached = lists.get(profileId)
    if (cached) return cached
    let items: DownloadItem[] = []
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir(profileId), INDEX), 'utf8'))
      if (Array.isArray(raw)) {
        items = raw
          .filter((i): i is DownloadItem => typeof i?.id === 'string' && typeof i?.name === 'string' && typeof i?.nodeId === 'string')
          .map((i) => ({ ...i, name: sanitizeDownloadName(i.name) })) // the index is a file on disk: never trust a name read from it
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('downloads.index', 'download index unreadable; starting empty', { ids: { profileId }, error: errMsg(err) })
    }
    const d = dir(profileId)
    items = settleAfterRestart(items, (i) => existsSync(join(d, i.name)), now0())
    lists.set(profileId, items)
    return items
  }
  const used = (profileId: string): number => load(profileId).reduce((n, i) => (i.state === 'completed' ? n + i.received : n), 0)
  const apply = (profileId: string, ev: DownloadEvent): DownloadItem[] => {
    const cur = load(profileId)
    const next = reduceDownloads(cur, ev, opts.max)
    // History cap: the file goes with its entry. An explicit `remove` is the caller's to delete (it knows the reason).
    if (ev.k !== 'remove') for (const gone of cur.filter((i) => !next.some((n) => n.id === i.id))) rmFile(profileId, gone)
    lists.set(profileId, next)
    if (ev.k !== 'progress') persist(profileId)
    return next
  }
  const expired = (items: DownloadItem[], now: number): DownloadItem[] =>
    items.filter((x) => x.state !== 'inProgress' && !x.pending && now - (x.endedAt ?? x.startedAt) > retention)
  const drop = (profileId: string, item: DownloadItem): void => { rmFile(profileId, item); apply(profileId, { k: 'remove', id: item.id }) }

  return {
    dir, pathOf, apply, used, items: load, deleteFile: rmFile,
    profileOf: (id) => [...lists].find(([, l]) => l.some((i) => i.id === id))?.[0],
    finalize(profileId, id, suggested) {
      const d = dir(profileId)
      if (!GUID.test(id)) throw new Error('downloads: invalid download id')
      const taken = new Set(load(profileId).filter((i) => i.id !== id && i.state !== 'inProgress').map((i) => i.name))
      const name = uniqueDownloadName(sanitizeDownloadName(suggested), taken)
      renameSync(join(d, id), join(d, name))
      chmodSync(join(d, name), FILE_MODE)
      return name
    },
    makeRoom(profileId, need, now) {
      for (const i of expired(load(profileId), now)) drop(profileId, i)
      for (const i of load(profileId).filter((x) => x.state === 'completed' && !x.pending)) { // oldest first
        if (used(profileId) + need <= quota) break
        drop(profileId, i)
      }
      return used(profileId) + need <= quota
    },
    sweep(now) {
      for (const [profileId, items] of [...lists]) for (const i of expired(items, now)) drop(profileId, i)
    },
  }
}
