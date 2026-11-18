// Derived state + toasts of one node's downloads. The list itself comes from the node's socket (`session.downloads`).
// A toast says when a download starts, ends or fails; the list the node attached with is seeded silently (no toasts for history).
import { useEffect, useMemo, useRef } from 'react'
import type { DownloadItem, DownloadState } from '../../shared/browser.downloads'
import { showNotice } from '../workspaceSave.notice'
import { DL_TEXT, failureText } from './browserDownloads.text'
import { downloadCounts, trackSpeed } from './browserDownloads.state'
import type { DownloadCounts, SpeedMap } from './browserDownloads.state'

const noticeKey = (id: string): string => `webterm-browser-download-${id}`

/** Toast for the change from `before` (undefined = unseen) to `item`, or null when nothing worth saying. */
export function downloadNotice(before: DownloadState | undefined, item: DownloadItem): { severity: 'info' | 'error' | 'warning'; title: string } | null {
  if (before === undefined && item.state === 'inProgress') return { severity: 'info', title: DL_TEXT.started(item.name) }
  if (before !== 'inProgress') return null
  if (item.state === 'completed') return item.pending ? { severity: 'warning', title: DL_TEXT.waiting(item.name) } : { severity: 'info', title: DL_TEXT.finished(item.name) }
  if (item.state === 'failed') return { severity: 'error', title: DL_TEXT.failed(item.name, failureText(item.failure)) }
  return null // canceled: the person did it, the row already says so
}

export interface BrowserDownloadsView { counts: DownloadCounts; speeds: SpeedMap }

export function useBrowserDownloads(items: readonly DownloadItem[]): BrowserDownloadsView {
  const seen = useRef<Map<string, DownloadState> | null>(null)
  const speeds = useRef<SpeedMap>({})
  const view = useMemo<BrowserDownloadsView>(() => {
    speeds.current = trackSpeed(speeds.current, items, Date.now())
    return { counts: downloadCounts(items), speeds: speeds.current }
  }, [items])

  useEffect(() => {
    const before = seen.current
    seen.current = new Map(items.map((i) => [i.id, i.state]))
    if (before === null) return // first sight: whatever the node already holds is history, not news
    for (const i of items) {
      const n = downloadNotice(before.get(i.id), i)
      if (n) showNotice(noticeKey(i.id), n)
    }
  }, [items])
  return view
}
