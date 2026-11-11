// Seconds left until a Retry-After deadline, re-rendering once a second (429 countdowns).
import { useEffect, useState } from 'react'

/** Ticks once a second while `until` (epoch ms) is ahead; returns the whole seconds left (0 = over). */
export function useCountdown(until: number, now: () => number = Date.now): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (until <= now()) return
    const timer = setInterval(() => {
      tick((n) => n + 1)
      if (now() >= until) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [until, now])
  return Math.max(0, Math.ceil((until - now()) / 1000))
}
