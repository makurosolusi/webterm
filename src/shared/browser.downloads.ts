// Download model of a browser node: one record per file, folded from the browser's events (begun -> progress -> done).
// Pure and shared: the server keeps the list, the client folds the same messages. No file system here.
import { hostOnly } from './browser.url'
import { isRiskyName, sanitizeDownloadName } from './browser.downloads.name'

export const DOWNLOAD_STATES = ['inProgress', 'completed', 'canceled', 'failed', 'missing'] as const
export type DownloadState = (typeof DOWNLOAD_STATES)[number]
/** Why a download failed; the UI words each one ("Disk full", "Over the size limit", ...). */
export const DOWNLOAD_FAILURES = ['network', 'disk_full', 'too_large', 'quota', 'blocked', 'interrupted', 'unknown'] as const
export type DownloadFailure = (typeof DOWNLOAD_FAILURES)[number]

/** Newest entries kept per node; the oldest finished ones go first (an unfinished download is never dropped). */
export const DOWNLOAD_HISTORY_MAX = 50
/** One file may not exceed this (checked from the announced size and again while it grows); the download is canceled. */
export const DOWNLOAD_MAX_FILE_BYTES = 2 * 1024 ** 3
/** All finished files of one profile together; older finished files are removed first to make room, then a new download is refused. */
export const DOWNLOAD_PROFILE_QUOTA_BYTES = 8 * 1024 ** 3
/** Finished files older than this are removed (file and entry) by the sweep. */
export const DOWNLOAD_RETENTION_MS = 14 * 24 * 3600_000
/** A download's progress reaches viewers at most this often (begin and end always pass). */
export const DOWNLOAD_PROGRESS_MIN_INTERVAL_MS = 250 // 4 per second

export interface DownloadItem {
  /** Browser-issued guid; also the name of the file until it finishes (then it is renamed to `name`). */
  id: string
  nodeId: string
  tabId?: string
  /** Safe stored file name (see browser.downloads.name.ts); unique inside the profile folder. */
  name: string
  /** Source address without credentials, query and fragment (a query can hold a token). */
  url: string
  host: string
  received: number
  /** Announced size; 0 = unknown. */
  total: number
  state: DownloadState
  failure?: DownloadFailure
  /** Executable type: the UI warns, nothing is blocked. */
  risky: boolean
  startedAt: number
  endedAt?: number
  /** "Ask before saving": a finished file waits for Keep / Discard in the node's popover. */
  pending?: boolean
}

/** Address safe to store and show: scheme, host and path only. */
export function redactDownloadUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return ''
  }
}

export type DownloadEvent =
  | { k: 'begin'; id: string; nodeId: string; tabId?: string; url: string; suggestedName: string; now: number }
  | { k: 'progress'; id: string; received: number; total: number }
  | { k: 'done'; id: string; state: 'completed' | 'canceled'; name?: string; now: number }
  | { k: 'fail'; id: string; failure: DownloadFailure; now: number }
  | { k: 'pending'; id: string; pending: boolean }
  | { k: 'missing'; id: string }
  | { k: 'remove'; id: string }

const isOpen = (i: DownloadItem): boolean => i.state === 'inProgress'

/** Keep the newest `max` entries of `nodeId`; the oldest finished ones are dropped, an open one never. */
function capNode(items: DownloadItem[], nodeId: string, max: number): DownloadItem[] {
  let over = items.filter((i) => i.nodeId === nodeId).length - max
  if (over <= 0) return items
  const drop = new Set<string>()
  for (const i of items) { // append-ordered: oldest first
    if (over <= 0) break
    if (i.nodeId === nodeId && !isOpen(i)) { drop.add(i.id); over-- }
  }
  return items.filter((i) => !drop.has(i.id))
}

const patch = (items: DownloadItem[], id: string, f: (i: DownloadItem) => DownloadItem): DownloadItem[] =>
  items.some((i) => i.id === id) ? items.map((i) => (i.id === id ? f(i) : i)) : items

/** Fold one event into the list (append-ordered, oldest first). A duplicate begin, or an event for an unknown id, changes nothing. */
export function reduceDownloads(items: DownloadItem[], ev: DownloadEvent, max: number = DOWNLOAD_HISTORY_MAX): DownloadItem[] {
  switch (ev.k) {
    case 'begin': {
      if (items.some((i) => i.id === ev.id)) return items
      const name = sanitizeDownloadName(ev.suggestedName)
      const item: DownloadItem = {
        id: ev.id, nodeId: ev.nodeId, ...(ev.tabId ? { tabId: ev.tabId } : {}), name, url: redactDownloadUrl(ev.url), host: hostOnly(ev.url),
        received: 0, total: 0, state: 'inProgress', risky: isRiskyName(name), startedAt: ev.now,
      }
      return capNode([...items, item], ev.nodeId, max)
    }
    case 'progress': return patch(items, ev.id, (i) => (isOpen(i) ? { ...i, received: Math.max(i.received, ev.received), total: ev.total > 0 ? ev.total : i.total } : i))
    case 'done': return patch(items, ev.id, (i) => {
      if (!isOpen(i)) return i
      const name = ev.name ?? i.name
      return { ...i, state: ev.state, name, risky: isRiskyName(name), total: ev.state === 'completed' && i.received > 0 ? i.received : i.total, endedAt: ev.now }
    })
    case 'fail': return patch(items, ev.id, (i) => (i.state === 'completed' ? i : { ...i, state: 'failed', failure: ev.failure, endedAt: ev.now }))
    case 'pending': return patch(items, ev.id, (i) => {
      const next = { ...i }
      if (ev.pending) next.pending = true
      else delete next.pending
      return next
    })
    case 'missing': return patch(items, ev.id, (i) => (i.state === 'completed' ? { ...i, state: 'missing' } : i))
    case 'remove': return items.filter((i) => i.id !== ev.id)
  }
}

/** Items of one node, newest first (the order the popover shows). */
export const downloadsOfNode = (items: readonly DownloadItem[], nodeId: string): DownloadItem[] =>
  items.filter((i) => i.nodeId === nodeId).reverse()

/** Progress 0..1, or null when the size is unknown. */
export const downloadFraction = (i: Pick<DownloadItem, 'received' | 'total'>): number | null =>
  i.total > 0 ? Math.min(1, i.received / i.total) : null

/** After a restart nothing is running anymore, and files that vanished are marked. */
export function settleAfterRestart(items: DownloadItem[], exists: (i: DownloadItem) => boolean, now: number): DownloadItem[] {
  return items.map((i) => {
    if (isOpen(i)) return { ...i, state: 'failed', failure: 'interrupted', endedAt: now }
    if (i.state === 'completed' && !exists(i)) return { ...i, state: 'missing' }
    return i
  })
}
