// The page area of a browser node the MAX_LIVE gate refused: the node exists on the board but has no page, so it must say
// so instead of showing a start page that looks usable. Offers the two ways out (hide another browser, try again); the
// server also retries by itself when a slot frees (browserWs.gateway `waiting`).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useBrowserStatus } from '../browser.feature'
import type { HideCandidate } from '../browser.hide'
import './browserTabs.css'

export const DOWN_TEXT = {
  title: 'Browser paused',
  limit: (n: number) => `The limit of ${n} active ${n === 1 ? 'browser' : 'browsers'} is reached. This one opens by itself as soon as another is hidden or closed.`,
  limitUnknown: 'The limit of active browsers is reached. This one opens by itself as soon as another is hidden or closed.',
  hide: 'Hide another browser…',
  none: 'No other browser is showing on this board.',
  retry: 'Try again',
  retrying: 'Trying again…',
  blockedNav: 'This browser is paused until a slot is free. Hide another browser or use Try again.',
} as const

export interface BrowserNodeDownProps {
  others: HideCandidate[]
  onHide: (id: string) => void
  onRetry: () => boolean
  /** Changes with every answer from the server (state or error), which ends the "trying again" progress. */
  answer: unknown
}

export function BrowserNodeDown({ others, onHide, onRetry, answer }: BrowserNodeDownProps) {
  const maxLive = useBrowserStatus()?.maxLive
  const [listing, setListing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setBusy(false) }, [answer])
  return (
    <div className="bt-overlay nodrag nowheel">
      <section className="bt-page" role="alert" aria-label="Browser paused">
        <h2>{DOWN_TEXT.title}</h2>
        <p>{maxLive ? DOWN_TEXT.limit(maxLive) : DOWN_TEXT.limitUnknown}</p>
        <div className="bt-address">
          <Button size="sm" variant="secondary" aria-expanded={listing} onClick={() => setListing((v) => !v)}>{DOWN_TEXT.hide}</Button>
          <Button size="sm" disabled={busy} onClick={() => setBusy(onRetry())}>{busy ? DOWN_TEXT.retrying : DOWN_TEXT.retry}</Button>
        </div>
        {listing && (others.length === 0
          ? <p>{DOWN_TEXT.none}</p>
          : (
            <ul className="bt-closed" aria-label="Active browsers">
              {others.map((o) => (
                <li key={o.id}><Button size="sm" variant="ghost" className="bt-closed-row" onClick={() => { onHide(o.id); setListing(false) }}>{o.label}</Button></li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  )
}
