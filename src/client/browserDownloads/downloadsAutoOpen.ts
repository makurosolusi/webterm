// Pure rules of the Downloads popover's auto-open (Chrome/Edge/Safari show the download bubble when a download starts).
import { downloadsOfNode } from '../../shared/browser.downloads'
import type { DownloadItem } from '../../shared/browser.downloads'

/** After the last download finishes cleanly and nobody touches the popover, it closes itself after this long. */
export const AUTO_CLOSE_MS = 6000
/** How long the toolbar button keeps its "finished" mark when the popover is closed. */
export const DONE_MARK_MS = 4000

/** Downloads of `nodeId` that are in progress and were not known before (`known` = ids seen so far). */
export function freshInProgress(known: ReadonlySet<string>, items: readonly DownloadItem[], nodeId: string): DownloadItem[] {
  return downloadsOfNode(items, nodeId).filter((i) => i.state === 'inProgress' && !known.has(i.id))
}

/** True when the popover may close by itself: nothing transfers and none of this session's downloads needs a look (failed, canceled, waiting for Keep / Discard). */
export function canAutoClose(items: readonly DownloadItem[], nodeId: string, session: ReadonlySet<string>): boolean {
  return downloadsOfNode(items, nodeId).every((i) => i.state !== 'inProgress' && !(session.has(i.id) && (i.state !== 'completed' || i.pending)))
}

/** False for a detached, `display:none`, `visibility:hidden`, `hidden`/`inert` element or a hidden window: nobody would see the popover. */
export function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || document.visibilityState === 'hidden') return false
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || n.hasAttribute('inert')) return false
    const cs = getComputedStyle(n)
    if (cs.display === 'none' || (n === el && cs.visibility === 'hidden')) return false
  }
  return true
}
