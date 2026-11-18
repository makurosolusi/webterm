// Pure client state of the downloads UI: folding server messages, badge counts, speed and the file kind of a name.
import type { DownloadItem } from '../../shared/browser.downloads'
import { downloadFraction } from '../../shared/browser.downloads'

/** The two download messages a node's socket carries. */
export type DownloadMsg = { t: 'download'; id: string; item: DownloadItem } | { t: 'downloads'; id: string; items: DownloadItem[] }

export const isDownloadMsg = (m: { t: string }): m is DownloadMsg => m.t === 'download' || m.t === 'downloads'

/** Fold one message: a list replaces everything, one item replaces its entry (or is appended when new). */
export function applyDownloadMsg(items: DownloadItem[], m: DownloadMsg): DownloadItem[] {
  if (m.t === 'downloads') return m.items
  return items.some((i) => i.id === m.item.id) ? items.map((i) => (i.id === m.item.id ? m.item : i)) : [...items, m.item]
}

export interface DownloadCounts {
  /** Still transferring. */
  active: number
  /** Finished and waiting for Keep / Discard ("Ask before saving"). */
  waiting: number
  /** Mean progress 0..1 of the transfers with a known size; null when none has one. */
  fraction: number | null
}

export function downloadCounts(items: readonly DownloadItem[]): DownloadCounts {
  const active = items.filter((i) => i.state === 'inProgress')
  const known = active.map(downloadFraction).filter((f): f is number => f !== null)
  return {
    active: active.length,
    waiting: items.filter((i) => i.pending && i.state === 'completed').length,
    fraction: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
  }
}

/** Per-download speed (bytes/s, smoothed) from successive samples; the last sample time and size are kept to diff the next one. */
export type SpeedMap = Record<string, { t: number; received: number; bps: number }>
const SMOOTHING = 0.4 // weight of the newest sample: reacts within a few updates yet does not jump on each one

export function trackSpeed(prev: SpeedMap, items: readonly DownloadItem[], now: number): SpeedMap {
  const next: SpeedMap = {}
  for (const i of items) {
    if (i.state !== 'inProgress') continue
    const p = prev[i.id]
    if (!p) { next[i.id] = { t: now, received: i.received, bps: 0 }; continue }
    const dt = (now - p.t) / 1000
    if (dt <= 0 || i.received === p.received) { next[i.id] = i.received === p.received ? p : { ...p, received: i.received }; continue }
    const inst = (i.received - p.received) / dt
    next[i.id] = { t: now, received: i.received, bps: p.bps === 0 ? inst : p.bps * (1 - SMOOTHING) + inst * SMOOTHING }
  }
  return next
}

/** Seconds left at the current speed; null when the size or the speed is unknown. */
export const etaSeconds = (i: Pick<DownloadItem, 'received' | 'total'>, bps: number): number | null =>
  i.total > 0 && bps > 0 ? Math.max(0, (i.total - i.received) / bps) : null

export type FileKind = 'image' | 'audio' | 'video' | 'archive' | 'code' | 'text' | 'file'
const KINDS: Array<[FileKind, string]> = [
  ['image', 'png jpg jpeg gif webp svg bmp ico heic avif tiff'], ['audio', 'mp3 wav flac aac ogg m4a opus'], ['video', 'mp4 mov mkv webm avi m4v'],
  ['archive', 'zip tar gz tgz bz2 xz 7z rar zst'], ['code', 'js ts tsx jsx json py rb go rs java c cpp h css html xml yaml yml sh'], ['text', 'txt md pdf doc docx rtf csv log odt'],
]
/** Icon family of a file name by its extension. */
export function fileKind(name: string): FileKind {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return name.includes('.') ? KINDS.find(([, exts]) => exts.split(' ').includes(ext))?.[0] ?? 'file' : 'file'
}

/** What the row says besides name and host. */
export type RowStatus = 'running' | 'done' | 'canceled' | 'failed' | 'missing'
export const rowStatus = (i: Pick<DownloadItem, 'state'>): RowStatus =>
  i.state === 'inProgress' ? 'running' : i.state === 'completed' ? 'done' : i.state

/** Chrome's rule: the toolbar button exists once this node has any download (running or in the list). */
export const hasDownloads = (items: readonly DownloadItem[], nodeId: string): boolean => items.some((i) => i.nodeId === nodeId)
