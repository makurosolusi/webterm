// Small data hooks shared by the central panels: one-shot load and offset-paged load.
import { useCallback, useEffect, useRef, useState } from 'react'
import { inboxErrorMessage, isAbortError } from '../inboxApi'
import { InboxApiError } from '../inboxTypes'
import { CL } from './centralLabels'
import { CENTRAL_PAGE_SIZE } from './centralControlApi'

/** Human text for a failed central call; the raw `GET /path failed (404 code)` line never reaches the panel. */
export function centralErrorMessage(err: unknown, fallback: string = CL.loadFailed): string {
  const text = inboxErrorMessage(err)
  return err instanceof InboxApiError && text === err.message ? fallback : text
}

/** Server code of a failed call (`skills_off`, `agents_off`, ...) so a panel can show an off state. */
const codeOf = (err: unknown): string | null => (err instanceof InboxApiError ? err.code : null)

/** How often an on-screen panel re-reads while nothing else tells it the numbers moved. */
export const LIVE_REFRESH_MS = 30_000

/**
 * Keeps a stays-mounted panel current: `refresh` runs when `visible` turns true again, when the browser tab
 * comes back, and every `LIVE_REFRESH_MS` while shown. The client has no app-wide "Central turn ended" signal
 * (only the open chat conversation sees it), so the interval covers a turn that ends while this panel is shown.
 */
export function useLiveRefresh(visible: boolean, refresh: () => void): void {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) refreshRef.current()
    wasVisible.current = visible
    if (!visible) return
    const tick = (): void => { if (document.visibilityState === 'visible') refreshRef.current() }
    const timer = setInterval(tick, LIVE_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [visible])
}

export interface Loaded<T> { data: T | null; error: string | null; code: string | null; loading: boolean; reload: () => void }

/** Loads once and on `reload()`; the in-flight request is aborted on unmount or reload. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data: T | null; error: string | null; code: string | null; loading: boolean }>({ data: null, error: null, code: null, loading: true })
  useEffect(() => {
    const ac = new AbortController()
    setState((s) => (s.data === null ? { ...s, loading: true } : s))
    loadRef.current(ac.signal).then(
      (data) => { if (!ac.signal.aborted) setState({ data, error: null, code: null, loading: false }) },
      (err: unknown) => {
        if (ac.signal.aborted || isAbortError(err)) return
        const code = codeOf(err)
        // A failed background refresh keeps what is shown; a feature that went off has nothing to show.
        setState((s) => ({ data: code?.endsWith('_off') ? null : s.data, error: centralErrorMessage(err), code, loading: false }))
      },
    )
    return () => ac.abort()
  }, [tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

export interface Paged<T> { items: T[]; error: string | null; code: string | null; loading: boolean; hasMore: boolean; loadMore: () => void; reload: () => void }

/** Offset pagination (Rule 13): first page on mount, `loadMore` appends the next page. */
export function usePaged<T>(fetchPage: (offset: number, signal: AbortSignal) => Promise<T[]>): Paged<T> {
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const [items, setItems] = useState<T[]>([])
  const [error, setError] = useState<{ text: string; code: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [req, setReq] = useState({ offset: 0, n: 0 })
  const loaded = useRef(false)
  useEffect(() => {
    const ac = new AbortController()
    if (!loaded.current) setLoading(true)
    fetchRef.current(req.offset, ac.signal).then(
      (rows) => {
        if (ac.signal.aborted) return
        loaded.current = true
        setItems((prev) => (req.offset === 0 ? rows : [...prev, ...rows]))
        setHasMore(rows.length >= CENTRAL_PAGE_SIZE)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) { setError({ text: centralErrorMessage(err), code: codeOf(err) }); setLoading(false) } },
    )
    return () => ac.abort()
  }, [req])
  const loadMore = useCallback(() => setReq((r) => ({ offset: items.length, n: r.n + 1 })), [items.length])
  const reload = useCallback(() => setReq((r) => ({ offset: 0, n: r.n + 1 })), [])
  return { items, error: error?.text ?? null, code: error?.code ?? null, loading, hasMore, loadMore, reload }
}
