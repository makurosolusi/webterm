import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from '../../inboxApi'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { centralErrorMessage } from '../centralLoad'
import type { TaskDetail as TaskDetailPage } from '../../../shared/centralWork'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { mergeTimeline, refreshLimit } from './taskBoardModel'

/** One task with its history; `refreshTick` re-reads it in the background without losing loaded pages. */
export function useTaskDetail(client: TaskBoardClient, taskId: string, refreshTick: number) {
  const [page, setPage] = useState<TaskDetailPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const pageRef = useRef<TaskDetailPage | null>(null)
  const moreRef = useRef<AbortController | null>(null)
  const apply = (next: TaskDetailPage): void => { pageRef.current = next; setPage(next) }

  useEffect(() => {
    const ac = new AbortController()
    const limit = refreshLimit(pageRef.current?.timeline.length ?? 0, CENTRAL_PAGE_SIZE)
    client.getTask(taskId, { limit, offset: 0 }, ac.signal).then(
      (fresh) => {
        if (ac.signal.aborted) return
        const before = pageRef.current
        apply({ ...fresh, timeline: mergeTimeline(before?.timeline ?? [], fresh.timeline) })
        setError(null)
      },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setError(centralErrorMessage(err, TL.detailFailed)) },
    )
    return () => ac.abort()
  }, [client, taskId, refreshTick, retryKey])

  useEffect(() => () => moreRef.current?.abort(), [])

  const loadMore = useCallback(() => {
    const before = pageRef.current
    if (!before || moreRef.current) return
    const ac = new AbortController()
    moreRef.current = ac
    setLoadingMore(true)
    client.getTask(taskId, { limit: CENTRAL_PAGE_SIZE, offset: before.timeline.length }, ac.signal).then(
      (next) => {
        const latest = pageRef.current
        if (!ac.signal.aborted && latest) apply({ ...latest, timeline: mergeTimeline(latest.timeline, next.timeline), hasMoreTimeline: next.hasMoreTimeline })
      },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setError(centralErrorMessage(err, TL.detailFailed)) },
    ).finally(() => {
      if (ac.signal.aborted) return
      moreRef.current = null
      setLoadingMore(false)
    })
  }, [client, taskId])

  return { page, error, loadingMore, loadMore, retry: () => setRetryKey((k) => k + 1) }
}
