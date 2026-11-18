// Downloads of the browser host: Chromium downloads into `<dataDir>/downloads/<profileId>/` (allowAndName) and tells us
// about it (`Browser.downloadWillBegin` / `downloadProgress`); this module maps each download to its node and tab,
// enforces the size limit and the profile quota, renames the finished file to a safe name and keeps the list.
// The browser process does the transfer and writes straight to disk, so a big file never passes through our memory.
import { statfsSync } from 'node:fs'
import { createLogger } from '../logs'
import { DOWNLOAD_MAX_FILE_BYTES, DOWNLOAD_PROGRESS_MIN_INTERVAL_MS } from '../../shared/browser.downloads'
import type { DownloadFailure, DownloadItem } from '../../shared/browser.downloads'
import { CDP, CDP_EVENT, ignoreClosed } from './cdp.client'
import type { CdpClient } from './cdp.client'
import type { DownloadStore } from './browser.downloads.store'
import type { HostEvent, TargetTable } from './browserHost.targets'

const log = createLogger('browser.downloads')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Free space below which an unrequested cancel is worded as "disk full" (Chromium reports every failure as `canceled`). */
const LOW_DISK_BYTES = 64 * 1024 ** 2

export type DownloadMode = 'save' | 'ask'

export interface DownloadsDeps {
  store: DownloadStore
  /** Profile a node's page runs in; undefined = unknown node. */
  profileOf(nodeId: string): string | undefined
  /** Node and tab a frame belongs to (a main frame's id is its target id); undefined = the host cannot tell. */
  resolve(profileId: string, frameId: string): { nodeId: string; tabId?: string } | undefined
  /** One download changed (progress is throttled before this is called). */
  emit(item: DownloadItem): void
  /** The node's whole list changed (an entry was removed). */
  emitList(nodeId: string, items: DownloadItem[]): void
  /** "Save to the webterm folder" or "Ask before saving" (Settings > Browser); read when a download starts. */
  mode(): DownloadMode
  now?: () => number
}

export interface HostDownloads {
  /** Folder Chromium saves into for this profile (created 0700). */
  folder(profileId: string): string
  /** Listen to one browser connection's download events. */
  attach(profileId: string, cdp: CdpClient): void
  /** The connection died: its running downloads cannot finish. */
  connectionLost(profileId: string): void
  list(nodeId: string): DownloadItem[]
  /** Stop a running download; false = it is not running here. */
  cancel(nodeId: string, id: string): boolean
  /** Remove an entry and delete its file (a running one is canceled first); false = unknown. */
  remove(nodeId: string, id: string): boolean
  /** "Ask before saving": keep a finished file. */
  keep(nodeId: string, id: string): boolean
  /** Path and name of a finished file for export, only for this node's own entry. */
  file(nodeId: string, id: string): { path: string; name: string } | undefined
}

interface Live { profileId: string; nodeId: string; ask: boolean; sized: boolean; lastEmit: number; by?: 'user' | 'limit' }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function createDownloads(d: DownloadsDeps): HostDownloads {
  const now = d.now ?? Date.now
  const live = new Map<string, Live>()
  const cdps = new Map<string, CdpClient>()
  const find = (nodeId: string, id: string): { profileId: string; item: DownloadItem } | undefined => {
    const profileId = d.profileOf(nodeId)
    const item = profileId === undefined ? undefined : d.store.items(profileId).find((i) => i.id === id && i.nodeId === nodeId)
    return profileId !== undefined && item ? { profileId, item } : undefined
  }
  const get = (profileId: string, id: string): DownloadItem | undefined => d.store.items(profileId).find((i) => i.id === id)
  const stop = (profileId: string, id: string): void => {
    cdps.get(profileId)?.send(CDP.cancelDownload, { guid: id }).catch(ignoreClosed(CDP.cancelDownload, { downloadId: id }))
  }
  const fail = (profileId: string, id: string, failure: DownloadFailure): void => {
    const l = live.get(id)
    d.store.apply(profileId, { k: 'fail', id, failure, now: now() })
    const item = get(profileId, id)
    if (item) { d.store.deleteFile(profileId, item); d.emit(item) }
    if (l) live.delete(id)
  }
  /** Over a limit: refuse it, say why, and tell the browser to stop writing. */
  const limit = (profileId: string, id: string, failure: DownloadFailure): void => {
    const l = live.get(id)
    if (l) l.by = 'limit'
    stop(profileId, id)
    fail(profileId, id, failure)
    if (l) live.set(id, l) // kept until Chromium's own `canceled` arrives, so that event is not read as a network failure
  }
  const diskLow = (profileId: string): boolean => {
    try {
      const s = statfsSync(d.store.dir(profileId))
      return s.bavail * s.bsize < LOW_DISK_BYTES
    } catch (err) {
      log.warn('downloads.disk', 'could not read free disk space', { error: errMsg(err) })
      return false
    }
  }

  const begin = (profileId: string, p: Record<string, unknown>): void => {
    const id = str(p.guid)
    const who = d.resolve(profileId, str(p.frameId))
    if (!id) return
    if (!who) { // no node to show it in: do not keep a file nobody can see
      log.warn('downloads.orphan', 'download of an unknown frame was canceled', { ids: { profileId } })
      cdps.get(profileId)?.send(CDP.cancelDownload, { guid: id }).catch(ignoreClosed(CDP.cancelDownload, { downloadId: id }))
      return
    }
    d.store.apply(profileId, { k: 'begin', id, nodeId: who.nodeId, ...(who.tabId ? { tabId: who.tabId } : {}), url: str(p.url), suggestedName: str(p.suggestedFilename), now: now() })
    live.set(id, { profileId, nodeId: who.nodeId, ask: d.mode() === 'ask', sized: false, lastEmit: now() })
    const item = get(profileId, id)
    if (item) d.emit(item)
    log.info('downloads.begin', 'download started', { ids: { profileId, nodeId: who.nodeId }, host: item?.host })
  }

  const complete = (profileId: string, id: string, l: Live): void => {
    const item = get(profileId, id)
    if (!item) return
    try {
      const name = d.store.finalize(profileId, id, item.name)
      d.store.apply(profileId, { k: 'done', id, state: 'completed', name, now: now() })
      if (l.ask) d.store.apply(profileId, { k: 'pending', id, pending: true })
    } catch (err) {
      log.error('downloads.finalize', 'could not store a finished download', { ids: { profileId }, error: errMsg(err) })
      fail(profileId, id, 'unknown')
      return
    }
    live.delete(id)
    const done = get(profileId, id)
    if (done) d.emit(done)
  }

  const progress = (profileId: string, p: Record<string, unknown>): void => {
    const id = str(p.guid)
    const l = live.get(id)
    if (!l) return
    const state = str(p.state)
    const received = num(p.receivedBytes)
    const total = num(p.totalBytes)
    if (state === 'completed') { d.store.apply(profileId, { k: 'progress', id, received, total }); complete(profileId, id, l); return }
    if (state === 'canceled') {
      live.delete(id)
      if (l.by) return // already settled by the user's cancel or a limit
      fail(profileId, id, diskLow(profileId) ? 'disk_full' : 'network')
      return
    }
    if (l.by) return
    d.store.apply(profileId, { k: 'progress', id, received, total })
    if (total > DOWNLOAD_MAX_FILE_BYTES || received > DOWNLOAD_MAX_FILE_BYTES) { limit(profileId, id, 'too_large'); return }
    if (!l.sized && total > 0) {
      l.sized = true
      if (!d.store.makeRoom(profileId, total, now())) { limit(profileId, id, 'quota'); return }
    }
    if (now() - l.lastEmit < DOWNLOAD_PROGRESS_MIN_INTERVAL_MS) return
    l.lastEmit = now()
    const item = get(profileId, id)
    if (item) d.emit(item)
  }

  const list = (nodeId: string): DownloadItem[] => {
    const profileId = d.profileOf(nodeId)
    return profileId === undefined ? [] : d.store.items(profileId).filter((i) => i.nodeId === nodeId)
  }
  const cancel = (nodeId: string, id: string): boolean => {
    const f = find(nodeId, id)
    const l = live.get(id)
    if (!f || !l || f.item.state !== 'inProgress') return false
    l.by = 'user'
    stop(f.profileId, id)
    d.store.apply(f.profileId, { k: 'done', id, state: 'canceled', now: now() })
    const item = get(f.profileId, id)
    if (item) { d.store.deleteFile(f.profileId, item); d.emit(item) }
    return true
  }

  return {
    folder: (profileId) => d.store.dir(profileId),
    attach(profileId, cdp) {
      cdps.set(profileId, cdp)
      cdp.on(CDP_EVENT.downloadWillBegin, (p) => begin(profileId, p))
      cdp.on(CDP_EVENT.downloadProgress, (p) => progress(profileId, p))
    },
    connectionLost(profileId) {
      cdps.delete(profileId)
      for (const [id, l] of [...live]) if (l.profileId === profileId) fail(profileId, id, 'interrupted')
    },
    list,
    cancel,
    remove(nodeId, id) {
      const f = find(nodeId, id)
      if (!f) return false
      if (f.item.state === 'inProgress') cancel(nodeId, id)
      const item = get(f.profileId, id) ?? f.item
      d.store.deleteFile(f.profileId, item)
      d.store.apply(f.profileId, { k: 'remove', id })
      live.delete(id)
      d.emitList(nodeId, list(nodeId))
      return true
    },
    keep(nodeId, id) {
      const f = find(nodeId, id)
      if (!f?.item.pending) return false
      d.store.apply(f.profileId, { k: 'pending', id, pending: false })
      const item = get(f.profileId, id)
      if (item) d.emit(item)
      return true
    },
    file(nodeId, id) {
      const f = find(nodeId, id)
      return f?.item.state === 'completed' ? { path: d.store.pathOf(f.profileId, f.item), name: f.item.name } : undefined
    },
  }
}

/** What the host needs to turn downloads on: the file store and the Settings mode; production wires both in browser.runtime.downloads.ts. */
export interface HostDownloadsDeps {
  store: DownloadStore
  mode(): DownloadMode
  /** Profile of a node the host has not opened yet (after a restart the board knows it, the host does not). */
  profileOfNode?(nodeId: string): string | undefined
}

/** Node and tab of a download's frame: a page's main frame id is its target id; an iframe's is not, so it falls back to a live node of the profile. */
export function resolveDownloadFrame(table: TargetTable, profileId: string, frameId: string): { nodeId: string; tabId?: string } | undefined {
  const view = table.target(frameId)
  if (view?.profileId === profileId) return { nodeId: view.nodeId, tabId: view.tabs?.state.activeTabId ?? undefined }
  const bg = table.bgTarget(frameId)
  if (bg?.rec.profileId === profileId) return { nodeId: bg.rec.nodeId, tabId: bg.tabId }
  const any = [...table.nodes.values()].find((r) => r.profileId === profileId && r.sessionId)
  return any && { nodeId: any.nodeId, tabId: any.tabs?.state.activeTabId ?? undefined }
}

/** The host's downloads: store and mode from `cfg`, frame lookup from the target table, changes out through `emit`. */
export function createHostDownloads(cfg: HostDownloadsDeps, table: TargetTable, emit: (e: HostEvent) => void, now?: () => number): HostDownloads {
  return createDownloads({
    store: cfg.store, mode: cfg.mode, now,
    profileOf: (id) => table.nodes.get(id)?.profileId ?? cfg.profileOfNode?.(id),
    resolve: (profileId, frameId) => resolveDownloadFrame(table, profileId, frameId),
    emit: (item) => emit({ k: 'download', nodeId: item.nodeId, item }),
    emitList: (nodeId, items) => emit({ k: 'downloads', nodeId, items }),
  })
}
