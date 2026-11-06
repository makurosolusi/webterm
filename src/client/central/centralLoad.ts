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

export interface Loaded<T> { data: T | null; error: string | null; code: string | null; loading: boolean; reload: () => void }

/** Loads once and on `reload()`; the in-flight request is aborted on unmount or reload. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data: T | null; error: string | null; code: string | null; loading: boolean }>({ data: null, error: null, code: null, loading: true })
  useEffect(() => {
    const ac = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    loadRef.current(ac.signal).then(
      (data) => { if (!ac.signal.aborted) setState({ data, error: null, code: null, loading: false }) },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setState({ data: null, error: centralErrorMessage(err), code: codeOf(err), loading: false }) },
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
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) { setError({ text: centralErrorMessage(err), code: codeOf(err) }); setLoading(false) } },
    )
    return () => ac.abort()
  }, [req])
  const loadMore = useCallback(() => setReq((r) => ({ offset: items.length, n: r.n + 1 })), [items.length])
  const reload = useCallback(() => setReq((r) => ({ offset: 0, n: r.n + 1 })), [])
  return { items, error: error?.text ?? null, code: error?.code ?? null, loading, hasMore, loadMore, reload }
}
