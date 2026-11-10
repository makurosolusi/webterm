import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../../inboxApi'
import { InboxApiError } from '../../inboxTypes'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { centralErrorMessage } from '../centralLoad'
import type { PageRange } from './taskBoardApi'
import { appendPage, mergeRefreshed, refreshLimit, TASK_BOARD_REFRESH_MS, type ListPage } from './taskBoardModel'

/** A paged list on the board's refresh rhythm; what is shown stays put through refreshes. `page` is null before the first answer. */
export function usePolledPages<T extends { id: string }>(
  fetchPage: (range: PageRange, signal: AbortSignal) => Promise<ListPage<T>>, scope: string | undefined, visible: boolean, failedText: string,
) {
  const [page, setPage] = useState<ListPage<T> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const pageRef = useRef<ListPage<T> | null>(null)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const refreshAc = useRef<AbortController | null>(null)
  const moreAc = useRef<AbortController | null>(null)
  const shownScope = useRef(scope)

  const commit = (next: ListPage<T> | null): void => { pageRef.current = next; setPage(next) }
  const fail = (err: unknown): void => {
    if (err instanceof InboxApiError && err.code.endsWith('_off')) { commit({ items: [], hasMore: false }); setError(null); return }
    setError(centralErrorMessage(err, failedText))
  }

  const refresh = useCallback(() => {
    refreshAc.current?.abort()
    const ac = new AbortController()
    refreshAc.current = ac
    const limit = refreshLimit(pageRef.current?.items.length ?? 0, CENTRAL_PAGE_SIZE)
    fetchRef.current({ limit, offset: 0 }, ac.signal).then(
      (next) => { if (!ac.signal.aborted) { commit(mergeRefreshed(pageRef.current ?? undefined, next, limit)); setError(null) } },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) fail(err) },
    )
  }, [])

  useEffect(() => {
    if (shownScope.current !== scope) {
      shownScope.current = scope
      moreAc.current?.abort()
      moreAc.current = null
      setLoadingMore(false)
      commit(null)
      setError(null)
    }
    if (!visible) return
    refresh()
    const tick = (): void => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(tick, TASK_BOARD_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [visible, scope, refresh])

  useEffect(() => () => { refreshAc.current?.abort(); moreAc.current?.abort() }, [])

  const loadMore = useCallback(() => {
    const current = pageRef.current
    if (!current || moreAc.current) return
    const ac = new AbortController()
    moreAc.current = ac
    setLoadingMore(true)
    fetchRef.current({ limit: CENTRAL_PAGE_SIZE, offset: current.items.length }, ac.signal).then(
      (next) => { if (!ac.signal.aborted && pageRef.current) commit(appendPage(pageRef.current, next)) },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) fail(err) },
    ).finally(() => {
      if (ac.signal.aborted) return
      moreAc.current = null
      setLoadingMore(false)
    })
  }, [])

  return { page, error, loading: page === null && error === null, loadingMore, refresh, loadMore }
}

/** Row actions: one at a time per row, a refusal becomes readable text, the list reloads either way. */
export function useRowActions(reload: () => void, errorText: (err: unknown) => string) {
  const inFlight = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (inFlight.current.has(key)) return false
    inFlight.current.add(key)
    setBusy(new Set(inFlight.current))
    setNotice(null)
    try {
      await action()
      return true
    } catch (err) {
      setNotice(errorText(err))
      return false
    } finally {
      inFlight.current.delete(key)
      setBusy(new Set(inFlight.current))
      reload()
    }
  }, [reload, errorText])

  return { busy, notice, run }
}
