// Poll-while-visible for the /m screens: load now, then every `ms` while the page is shown (a
// phone in a pocket should not keep the radio busy), and again the moment it comes back or the
// network does (`online`), so a screen left on after a dead zone does not wait a whole interval.
import { useCallback, useEffect, useRef, useState } from 'react'
import { inboxErrorMessage, isAbortError } from '../inboxApi'

export function usePoll<T>(load: () => Promise<T>, ms: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    loadRef.current().then((d) => { if (alive) { setData(d); setError(null) } }, (err: unknown) => {
      if (alive && !isAbortError(err)) setError(inboxErrorMessage(err))
    })
    return () => { alive = false }
  }, [tick])

  useEffect(() => {
    if (ms <= 0) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload() }, ms)
    const onShow = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('online', onShow)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('online', onShow)
    }
  }, [ms, reload])

  return { data, error, reload }
}
