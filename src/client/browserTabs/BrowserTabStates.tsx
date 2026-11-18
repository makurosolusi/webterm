// Full-panel states of a tab: crashed (Reload), navigation error / offline (message + Retry), discarded (reloads
// itself when the tab becomes active, with a spinner). `BrowserTabStateView` picks the right one or returns null.
import { useEffect, useRef } from 'react'
import { LoaderCircle, TriangleAlert, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BrowserTab } from '../../shared/browser.tabs'
import { hostOf, tabTitle } from './browserTabs.labels'
import './browserTabs.css'

export function BrowserTabCrashed({ onReload }: { onReload: () => void }) {
  return (
    <section className="bt-page bt-page--error" role="alert" aria-label="Tab crashed">
      <TriangleAlert aria-hidden="true" />
      <h2>This tab crashed</h2>
      <p>The page stopped responding. Reload to try again; other tabs are not affected.</p>
      <Button size="bui" onClick={onReload}>Reload</Button>
    </section>
  )
}

export interface NavErrorInfo {
  /** Short human cause, e.g. "The site could not be reached". */
  message: string
  /** True when the machine itself is offline (different wording, same Retry). */
  offline?: boolean
}

export function BrowserTabNavError({ error, url, onRetry }: { error: NavErrorInfo; url: string; onRetry: () => void }) {
  const host = hostOf(url)
  return (
    <section className="bt-page bt-page--error" role="alert" aria-label="Page could not be loaded">
      {error.offline ? <WifiOff aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <h2>{error.offline ? 'You are offline' : host ? `Could not load ${host}` : 'Could not load the page'}</h2>
      <p>{error.message}</p>
      <Button size="bui" onClick={onRetry}>Retry</Button>
    </section>
  )
}

/** Shown while a discarded tab wakes; asks the parent to reload exactly once per mount. */
export function BrowserTabDiscarded({ tab, onWake }: { tab: BrowserTab; onWake: () => void }) {
  const woke = useRef(false)
  useEffect(() => {
    if (woke.current) return
    woke.current = true
    onWake()
  }, [onWake])
  return (
    <section className="bt-page" role="status" aria-label="Reloading tab">
      <LoaderCircle className="bt-spinner" aria-hidden="true" />
      <p>Reloading {tabTitle(tab)}...</p>
    </section>
  )
}

export interface BrowserTabStateViewProps {
  tab: BrowserTab
  error?: NavErrorInfo
  onReload: () => void
  onWake: () => void
}

/** Crashed beats discarded beats a navigation error; null when the tab should show its page. */
export function BrowserTabStateView({ tab, error, onReload, onWake }: BrowserTabStateViewProps) {
  if (tab.crashed) return <BrowserTabCrashed onReload={onReload} />
  if (tab.discarded) return <BrowserTabDiscarded tab={tab} onWake={onWake} />
  if (error) return <BrowserTabNavError error={error} url={tab.url} onRetry={onReload} />
  return null
}
