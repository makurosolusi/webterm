// "No match" mark of one pane: sync could not find the element you used in another pane. Shown for a few seconds, only on
// that pane; the others carry on. Announced politely (role=status) so it is not only a visual cue.
import { useEffect, useState } from 'react'
import { MISS_LABEL, MISS_TITLE, MISS_TTL_MS, activeMiss } from './browserSync'
import type { SyncView } from './browserSync'
import './browserSync.css'

export function BrowserSyncMiss({ sync, tabId }: { sync: SyncView; tabId: string }) {
  const [now, setNow] = useState(() => Date.now())
  const miss = sync.miss[tabId]
  useEffect(() => {
    if (!miss) return
    setNow(Date.now())
    const t = setTimeout(() => setNow(Date.now()), MISS_TTL_MS + 20)
    return () => clearTimeout(t)
  }, [miss])
  const shown = activeMiss(sync, tabId, now)
  if (!sync.on || !shown) return null
  return <div className="bsync-miss" role="status" title={MISS_TITLE[shown.reason]} data-reason={shown.reason}>{MISS_LABEL[shown.reason]}</div>
}
