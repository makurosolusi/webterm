// "Review checks" on the task detail: health findings the review gate recorded for this task's changed
// files. Read-only; dismissing happens in the Health tab.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { FindingView } from '../../../shared/centralHealth'
import { isAbortError } from '../../inboxApi'
import { centralErrorMessage } from '../centralLoad'
import { LEVEL_LABEL, STATUS_LABEL, locationOf } from '../health/healthModel'
import type { TaskBoardClient } from './taskBoardApi'

export const THL = {
  heading: 'Review checks',
  loading: 'Checking changed files…',
  none: 'No issues found in changed files',
  failed: 'Could not load the review checks.',
  retry: 'Retry',
  more: 'More checks are in the Health tab.',
  suggestion: (s: string) => `Suggestion: ${s}`,
} as const

type State = { items: FindingView[]; hasMore: boolean } | { error: string } | null

function Finding({ f }: { f: FindingView }): React.JSX.Element {
  return (
    <li className="task-detail__attempt" data-severity={f.severity} data-status={f.status}>
      <strong>{LEVEL_LABEL[f.severity]}</strong> {f.title}{f.status !== 'open' && <span className="task-card__meta"> · {STATUS_LABEL[f.status]}</span>}
      <p className="task-card__meta">{locationOf(f)}</p>
      <p className="task-detail__text">{f.evidence}</p>
      <p className="task-card__meta">{f.source}</p>
      <p>{THL.suggestion(f.suggestion)}</p>
    </li>
  )
}

/** Review-check findings of one task; `refreshTick` re-reads them in the background. */
export function TaskHealth({ client, taskId, refreshTick }: { client: TaskBoardClient; taskId: string; refreshTick: number }): React.JSX.Element {
  const [state, setState] = useState<State>(null)
  const [retryKey, setRetryKey] = useState(0)
  useEffect(() => { setState(null) }, [taskId])
  useEffect(() => {
    const ac = new AbortController()
    client.listTaskFindings(taskId, ac.signal).then(
      (page) => { if (!ac.signal.aborted) setState(page) },
      (err: unknown) => {
        if (ac.signal.aborted || isAbortError(err)) return
        // A failed background refresh keeps the list already shown.
        setState((s) => (s && 'items' in s ? s : { error: centralErrorMessage(err, THL.failed) }))
      },
    )
    return () => ac.abort()
  }, [client, taskId, refreshTick, retryKey])

  let body: React.JSX.Element
  if (state === null) body = <p role="status" className="task-card__meta">{THL.loading}</p>
  else if ('error' in state) body = <div role="alert" className="task-board__error">{state.error} <Button type="button" size="xs" variant="secondary" onClick={() => { setState(null); setRetryKey((k) => k + 1) }}>{THL.retry}</Button></div>
  else if (state.items.length === 0) body = <p className="task-card__meta">{THL.none}</p>
  else body = (
    <>
      <ul className="task-detail__list" aria-label={THL.heading}>{state.items.map((f) => <Finding key={f.id} f={f} />)}</ul>
      {state.hasMore && <p className="task-card__meta">{THL.more}</p>}
    </>
  )
  return <><h4>{THL.heading}</h4>{body}</>
}
