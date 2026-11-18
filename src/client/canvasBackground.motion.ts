// Window state that decides whether a moving wallpaper runs: visible + focused, and the OS
// "reduce motion" preference. Hooks live apart from the pure rules in canvasBackground.media.ts.
import { useEffect, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const windowIsActive = (): boolean => !document.hidden && document.hasFocus()

/** True while the document is visible and the window focused (focus moving into an iframe still counts). */
export function useWindowActive(): boolean {
  const [active, setActive] = useState(windowIsActive)
  useEffect(() => {
    const sync = (): void => setActive(windowIsActive())
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    sync()
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [])
  return active
}

/** The OS "reduce motion" preference, live. False where `matchMedia` does not exist. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED_MOTION_QUERY)
    if (!mq) return
    const sync = (): void => setReduced(mq.matches)
    mq.addEventListener('change', sync)
    sync()
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}
