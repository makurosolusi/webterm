// Badge state for the Dock's Inbox button, split out of App/Dock so both stay small.
//
// WHO FETCHES WHAT: exactly one POLLER at a time. `InboxPanel` owns the list while it is open and
// polls it; the badge then takes its number from `publishInboxCount` instead of polling the same
// endpoint again (the "no fetch storm" rule). The badge still seeds its own count once on
// mount/open, because on boot the panel may already be open and a badge that only appears after
// the first close is simply wrong.
//
// Failure is not surfaced here: the badge is advisory, and a stale count is better than a Dock
// that turns red because the operator was offline for a minute. The panel itself reports errors.
import { useEffect, useRef, useState } from 'react'
import { inboxApi, type InboxClient, type InboxItem } from './inboxApi'

/** Matches the panel's own interval when App passes `pollMs={30_000}` to `<InboxPanel>`. */
export const INBOX_POLL_MS = 30_000

/** Three digits do not fit the dock button; beyond this the badge stops growing. */
export const INBOX_BADGE_MAX = 99

// ---- shared count between the open panel and the Dock badge --------------------------------
// `null` means "the panel is not publishing" (closed, or no data yet). Module scope is enough:
// there is one panel and one dock per document, and it must survive the panel unmounting.
let sharedCount: number | null = null
const countListeners = new Set<(count: number | null) => void>()

/** Publish the open panel's count so the badge follows consume/reject immediately. */
export function publishInboxCount(count: number | null): void {
  if (sharedCount === count) return
  sharedCount = count
  for (const listener of countListeners) listener(count)
}

/** The count published by the open panel, or null while it is not publishing. */
export function usePublishedInboxCount(): number | null {
  const [count, setCount] = useState(sharedCount)
  useEffect(() => {
    const listener = (next: number | null): void => setCount(next)
    countListeners.add(listener)
    setCount(sharedCount)
    return () => {
      countListeners.delete(listener)
    }
  }, [])
  return count
}

/** Items the server lists are exactly the ones still waiting for the operator. */
export function inboxUnread(items: readonly InboxItem[]): number {
  return items.length
}

/** `''` means "render no badge at all". */
export function formatInboxBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  const whole = Math.floor(count)
  return whole > INBOX_BADGE_MAX ? `${INBOX_BADGE_MAX}+` : String(whole)
}

/** Same "is the key going to a text field?" test the canvas shortcuts use. `i` must stay a
 *  letter everywhere a human can type: terminals (xterm writes into a textarea), search boxes,
 *  rename inputs, the approval phrase field. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  if (el.isContentEditable === true) return true
  if (typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Plain `i` toggles the inbox. Modifier chords and typing are left alone. */
export function useInboxHotkey(onToggle: () => void, enabled = true): void {
  const toggleRef = useRef(onToggle)
  toggleRef.current = onToggle
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'i') return
      if (isTypingTarget(event.target)) return
      // Dialog persetujuan/overlay lain sedang memegang layar: menutup panel di bawahnya akan
      // mencabut percakapan yang sedang berjalan. Escape adalah jalan keluarnya, bukan `i`.
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

export interface InboxBadgeOptions {
  /** The panel is on screen: the badge reads its published count and does not poll. */
  panelOpen: boolean
  /** False before boot hydration and on the Welcome screen: nothing to badge yet. */
  enabled?: boolean
  pollMs?: number
  /** Stable in production (module default); injected in tests. */
  client?: InboxClient
}

/**
 * Unread count for the Dock button. Seeds once on mount (panel open or not, so a boot with the
 * panel visible still badges), then polls every `pollMs` ONLY while the panel is closed. While
 * the panel is open, `useInboxCountPublisher` supplies the number, so consume/reject update the
 * badge without a second poller. Never overlaps its own requests; keeps the last count on failure.
 */
export function useInboxBadge(options: InboxBadgeOptions): number {
  const { panelOpen, enabled = true, pollMs = INBOX_POLL_MS, client = inboxApi } = options
  const [count, setCount] = useState(0)
  const published = usePublishedInboxCount()
  // Refs, not deps: an inline client must not restart the poll loop (same rule as InboxPanel).
  const clientRef = useRef<InboxClient>(client)
  clientRef.current = client

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let inFlight = false
    const controller = new AbortController()

    const load = (): void => {
      if (disposed || inFlight) return
      // A background tab has nobody looking at the badge; skip instead of piling up requests.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      inFlight = true
      clientRef.current
        .listInbox({ signal: controller.signal })
        .then((items) => {
          if (!disposed) setCount(inboxUnread(items))
        })
        .catch(() => {
          // Badge stays at its last value; the panel is where errors are explained.
        })
        .finally(() => {
          inFlight = false
        })
    }

    // One seed per mount/open. Polling is the panel-closed case only.
    load()
    const timer = !panelOpen && pollMs > 0 ? setInterval(load, pollMs) : null
    const onVisibility = (): void => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      controller.abort()
      if (timer !== null) clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, panelOpen, pollMs])

  return panelOpen && published !== null ? published : count
}
