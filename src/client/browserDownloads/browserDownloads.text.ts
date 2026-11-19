// Wording and number formatting of the downloads UI (one place, English like the rest of the product).
import type { DownloadFailure, DownloadItem } from '../../shared/browser.downloads'

export const DL_TEXT = {
  button: 'Downloads',
  buttonActive: (n: number) => `Downloads, ${n} in progress`,
  buttonPending: (n: number) => `Downloads, ${n} waiting for your choice`,
  buttonDone: 'Downloads, finished',
  tip: 'Downloads (saved in the webterm folder, not your Downloads folder)',
  title: 'Downloads',
  empty: 'No downloads yet',
  emptyHint: 'Files a page downloads are saved in the webterm folder for this profile.',
  cancel: 'Cancel download',
  remove: 'Remove from list and delete the file',
  copyPath: 'Copy file path',
  saveCopy: 'Save a copy…',
  keep: 'Keep',
  discard: 'Discard',
  askQuestion: 'Keep this file?',
  copied: 'Path copied',
  copyFailed: 'Could not copy the path',
  saveStarted: 'Your browser is saving a copy',
  actionFailed: (what: string) => `${what} failed`,
  risky: 'This file type can run code when opened. Only keep it if you trust the page it came from.',
  missing: 'The file is gone from the webterm folder',
  canceled: 'Canceled',
  failedPrefix: 'Failed',
  started: (name: string) => `Downloading ${name}`,
  finished: (name: string) => `Downloaded ${name}`,
  failed: (name: string, why: string) => `Download of ${name} failed: ${why}`,
  waiting: (name: string) => `${name} is ready. Keep or discard it in Downloads.`,
  sizeUnknown: 'size unknown',
} as const

const FAILURE_TEXT: Record<DownloadFailure, string> = {
  network: 'the network connection was lost',
  disk_full: 'the disk is full',
  too_large: 'the file is over the size limit',
  quota: 'the profile download quota is full',
  blocked: 'it was blocked',
  interrupted: 'webterm restarted or the browser stopped',
  unknown: 'something went wrong while saving it',
}

/** Plain-language reason for a failed download. */
export const failureText = (f: DownloadFailure | undefined): string => FAILURE_TEXT[f ?? 'unknown']

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
/** `1536` -> `1.5 KB` (1024 steps, one decimal under 10). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++ }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[u]}`
}

export const formatSpeed = (bytesPerSec: number): string => `${formatBytes(bytesPerSec)}/s`

/** `75` -> `1 min 15 s left`; under a minute in seconds, over an hour in hours and minutes. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.ceil(seconds)
  if (s < 60) return `${s} s left`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s left`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left`
}

/** "12 MB of 40 MB" / "12 MB" while the size is unknown / "40 MB" when done. */
export function sizeLine(i: Pick<DownloadItem, 'received' | 'total' | 'state'>): string {
  if (i.state === 'completed' || i.state === 'missing') return formatBytes(i.total || i.received)
  return i.total > 0 ? `${formatBytes(i.received)} of ${formatBytes(i.total)}` : formatBytes(i.received)
}
