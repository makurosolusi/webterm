// Liveness of the shared terminal socket (ws.ts): an app-level heartbeat and the browser events
// that mean "the network or the machine just came back".
// A sleeping laptop or a switched Wi-Fi leaves a socket that looks OPEN but delivers nothing (no
// close event for minutes). Browsers cannot see the server's ws-level pings, so the tab sends its
// own `{t:'ping'}` and gives up on the socket when no `pong` returns in time.

/** Interval of the app-level ping while connected. */
export const HEARTBEAT_MS = 25_000
/** No pong within this after a ping = half-open socket: drop it and reconnect. */
export const PONG_TIMEOUT_MS = 10_000
/** focus + visibilitychange + pageshow often fire together; act on the first only. */
export const WAKE_THROTTLE_MS = 1_000

export interface Heartbeat {
  /** Start pinging (socket opened). */
  start(): void
  /** Stop pinging and forget the pending ping (socket closed). */
  stop(): void
  /** Ping now unless one is already waiting for its pong. */
  probe(): void
  /** A pong arrived. */
  pong(id: string): void
}

/** Heartbeat that calls `send(id)` to ping and `dead()` when a pong is late. */
export function createHeartbeat(send: (id: string) => void, dead: () => void): Heartbeat {
  let seq = 0
  let pending: string | null = null
  let interval: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const hb: Heartbeat = {
    start() { hb.stop(); interval = setInterval(hb.probe, HEARTBEAT_MS) },
    stop() { clearInterval(interval); clearTimeout(deadline); interval = deadline = undefined; pending = null },
    probe() {
      if (pending) return
      pending = String(++seq)
      deadline = setTimeout(() => { pending = null; dead() }, PONG_TIMEOUT_MS)
      send(pending)
    },
    pong(id) {
      if (id !== pending) return
      clearTimeout(deadline)
      pending = null
    },
  }
  return hb
}

/**
 * Listen to the wake events (`online`, page visible again, bfcache restore, window focus) and
 * `offline`. `wake` is throttled except for `online`, which must never be swallowed: retries are
 * paused while offline and only `online` resumes them. Returns uninstall; no-op without a window.
 */
export function installWakeTriggers(h: { wake(): void; offline(): void }): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  let last = -Infinity
  const throttled = (): void => {
    const now = Date.now()
    if (now - last < WAKE_THROTTLE_MS) return
    last = now
    h.wake()
  }
  const onOnline = (): void => { last = Date.now(); h.wake() }
  const onOffline = (): void => h.offline()
  const onVisible = (): void => { if (document.visibilityState === 'visible') throttled() }
  const onPageShow = (e: Event): void => { if ((e as PageTransitionEvent).persisted) throttled() }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('focus', throttled)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('focus', throttled)
    window.removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** Browser reports no network. A loopback server stays reachable offline, so it never counts. */
export function browserOffline(): boolean {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return false
  const host = typeof location === 'undefined' ? '' : location.hostname ?? ''
  return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(host)
}
