// Badge state for the Dock's Inbox button, split out of App/Dock so both stay small.
//
// WHO FETCHES WHAT: `InboxPanel` owns the list while it is open (and honours its own `pollMs`).
// The badge hook therefore stays SILENT while the panel is open and takes over once it closes.
// Two pollers on the same endpoint would double every request for no extra information — the
// "no fetch storm" rule — so exactly one of them is ever ticking.
//
// Failure is not surfaced here: the badge is advisory, and a stale count is better than a Dock
// that turns red because the operator was offline for a minute. The panel itself reports errors.
import { useEffect, useRef, useState } from 'react'
import { inboxApi, type InboxClient, type InboxItem } from './inboxApi'

/** Matches the panel's own interval when App passes `pollMs={30_000}` to `<InboxPanel>`. */
export const INBOX_POLL_MS = 30_000

/** Three digits do not fit the dock button; beyond this the badge stops growing. */
export const INBOX_BADGE_MAX = 99

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
  /** The panel is on screen: it is already fetching, so the badge does not. */
  panelOpen: boolean
  /** False before boot hydration and on the Welcome screen: nothing to badge yet. */
  enabled?: boolean
  pollMs?: number
  /** Stable in production (module default); injected in tests. */
  client?: InboxClient
}

/**
 * Unread count for the Dock button. Refreshes on mount / when the panel closes, then every
 * `pollMs` while the tab is visible. Never overlaps its own requests, never runs while the
 * panel owns the endpoint, and keeps the last count on failure.
 */
export function useInboxBadge(options: InboxBadgeOptions): number {
  const { panelOpen, enabled = true, pollMs = INBOX_POLL_MS, client = inboxApi } = options
  const [count, setCount] = useState(0)
  // Refs, not deps: an inline client must not restart the poll loop (same rule as InboxPanel).
  const clientRef = useRef<InboxClient>(client)
  clientRef.current = client

  useEffect(() => {
    if (!enabled || panelOpen) return
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

    load()
    const timer = pollMs > 0 ? setInterval(load, pollMs) : null
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

  return count
}
