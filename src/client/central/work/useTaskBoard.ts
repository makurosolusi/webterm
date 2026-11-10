import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardColumn } from '../../../shared/centralWork'
import { isAbortError } from '../../inboxApi'
import { InboxApiError } from '../../inboxTypes'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { centralErrorMessage } from '../centralLoad'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { actionErrorText, appendPage, COLUMN_ORDER, mergeRefreshed, refreshLimit, TASK_BOARD_REFRESH_MS, type ColumnState, type TaskAction } from './taskBoardModel'

type Columns = Record<BoardColumn, ColumnState>

/** Board data: per-column pages, kept through background refreshes. `columns` is null only before the first answer. */
export function useTaskBoard(client: TaskBoardClient, projectId: string | undefined, visible: boolean) {
  const [columns, setColumns] = useState<Columns | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [off, setOff] = useState(false)
  const [loadingMore, setLoadingMore] = useState<ReadonlySet<BoardColumn>>(new Set())
  const [refreshTick, setRefreshTick] = useState(0)
  const columnsRef = useRef<Columns | null>(null)
  const refreshAc = useRef<AbortController | null>(null)
  const moreAc = useRef<AbortController | null>(null)
  const moreBusy = useRef(new Set<BoardColumn>())
  const shownProject = useRef(projectId)

  const commit = (next: Columns | null): void => { columnsRef.current = next; setColumns(next) }
  const markMore = (): void => setLoadingMore(new Set(moreBusy.current))

  const refresh = useCallback(() => {
    refreshAc.current?.abort()
    const ac = new AbortController()
    refreshAc.current = ac
    const before = columnsRef.current
    const limits = COLUMN_ORDER.map((c) => refreshLimit(before?.[c].items.length ?? 0, CENTRAL_PAGE_SIZE))
    Promise.all(COLUMN_ORDER.map((c, i) => client.listColumn(c, projectId, { limit: limits[i]!, offset: 0 }, ac.signal))).then(
      (pages) => {
        if (ac.signal.aborted) return
        const latest = columnsRef.current
        commit(Object.fromEntries(COLUMN_ORDER.map((c, i) => [c, mergeRefreshed(latest?.[c], pages[i]!, limits[i]!)])) as Columns)
        setError(null)
        setOff(false)
        setRefreshTick((t) => t + 1)
      },
      (err: unknown) => {
        if (ac.signal.aborted || isAbortError(err)) return
        if (err instanceof InboxApiError && err.code.endsWith('_off')) { commit(null); setOff(true); return }
        setError(centralErrorMessage(err, TL.loadFailed))
      },
    )
  }, [client, projectId])

  useEffect(() => {
    if (shownProject.current !== projectId) {
      shownProject.current = projectId
      moreAc.current?.abort()
      moreAc.current = null
      moreBusy.current.clear()
      markMore()
      commit(null)
      setError(null)
    }
    if (!visible) return
    refresh()
    const tick = (): void => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(tick, TASK_BOARD_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [visible, projectId, refresh])

  useEffect(() => () => {
    refreshAc.current?.abort()
    moreAc.current?.abort()
    moreAc.current = null
  }, [])

  const loadMore = useCallback((column: BoardColumn) => {
    const current = columnsRef.current?.[column]
    if (!current || moreBusy.current.has(column)) return
    moreAc.current ??= new AbortController()
    const { signal } = moreAc.current
    moreBusy.current.add(column)
    markMore()
    client.listColumn(column, projectId, { limit: CENTRAL_PAGE_SIZE, offset: current.items.length }, signal).then(
      (page) => {
        const latest = columnsRef.current
        if (!signal.aborted && latest) commit({ ...latest, [column]: appendPage(latest[column], page) })
      },
      (err: unknown) => { if (!signal.aborted && !isAbortError(err)) setError(centralErrorMessage(err, TL.loadFailed)) },
    ).finally(() => {
      if (signal.aborted) return
      moreBusy.current.delete(column)
      markMore()
    })
  }, [client, projectId])

  const retry = useCallback(() => { setError(null); setOff(false); refresh() }, [refresh])

  return { columns, error, off, loading: columns === null && error === null && !off, loadingMore, refreshTick, refresh, retry, loadMore }
}

/** Runs card actions: one at a time per card, refused ones keep their text on the card, the board reloads either way. */
export function useTaskActions(client: TaskBoardClient, reload: () => void) {
  const inFlight = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({})

  const act = useCallback(async (id: string, action: TaskAction, body?: Record<string, string>): Promise<boolean> => {
    if (inFlight.current.has(id)) return false
    inFlight.current.add(id)
    setBusy(new Set(inFlight.current))
    setRefused(({ [id]: _cleared, ...rest }) => rest)
    try {
      await client.act(id, action, body)
      return true
    } catch (err) {
      setRefused((r) => ({ ...r, [id]: actionErrorText(err) }))
      return false
    } finally {
      inFlight.current.delete(id)
      setBusy(new Set(inFlight.current))
      reload()
    }
  }, [client, reload])

  return { busy, refused, act }
}
