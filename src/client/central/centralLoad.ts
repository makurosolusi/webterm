// Small data hooks shared by the central panels: one-shot load and offset-paged load.
import { useCallback, useEffect, useRef, useState } from 'react'
import { inboxErrorMessage, isAbortError } from '../inboxApi'
import { CENTRAL_PAGE_SIZE } from './centralControlApi'

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Loads once and on `reload()`; the in-flight request is aborted on unmount or reload. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  useEffect(() => {
    const ac = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    loadRef.current(ac.signal).then(
      (data) => { if (!ac.signal.aborted) setState({ data, error: null, loading: false }) },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setState({ data: null, error: inboxErrorMessage(err), loading: false }) },
    )
    return () => ac.abort()
  }, [tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

export interface Paged<T> { items: T[]; error: string | null; loading: boolean; hasMore: boolean; loadMore: () => void; reload: () => void }

/** Offset pagination (Rule 13): first page on mount, `loadMore` appends the next page. */
export function usePaged<T>(fetchPage: (offset: number, signal: AbortSignal) => Promise<T[]>): Paged<T> {
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const [items, setItems] = useState<T[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [req, setReq] = useState({ offset: 0, n: 0 })
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchRef.current(req.offset, ac.signal).then(
      (rows) => {
        if (ac.signal.aborted) return
        setItems((prev) => (req.offset === 0 ? rows : [...prev, ...rows]))
        setHasMore(rows.length >= CENTRAL_PAGE_SIZE)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) { setError(inboxErrorMessage(err)); setLoading(false) } },
    )
    return () => ac.abort()
  }, [req])
  const loadMore = useCallback(() => setReq((r) => ({ offset: items.length, n: r.n + 1 })), [items.length])
  const reload = useCallback(() => setReq((r) => ({ offset: 0, n: r.n + 1 })), [])
  return { items, error, loading, hasMore, loadMore, reload }
}
