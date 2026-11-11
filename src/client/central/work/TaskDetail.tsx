import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import type { AssignmentView, TaskCard as TaskCardData, WorkEventView } from '../../../shared/centralWork'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { actorWords, eventWords, outcomeText, ruleWords, verificationVerdict } from './taskBoardModel'
import { TaskHealth } from './taskHealth'
import { useTaskDetail } from './useTaskDetail'

export interface TaskDetailProps {
  client: TaskBoardClient
  taskId: string
  refreshTick: number
  onClose: () => void
}

const when = (at: number): string => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function Attempt({ a, nodeName }: { a: AssignmentView; nodeName: string }): React.JSX.Element {
  const result = outcomeText(a.result)
  return (
    <li className="task-detail__attempt">
      <strong>{TL.attempt(a.attempt)}</strong>
      <span className="task-card__meta"> · {TL.channels[a.channel]} · {nodeName}</span>
      <p className="task-card__meta">{TL.startedAt(when(a.startedAt))}</p>
      <p>{a.endedAt === null ? TL.stillRunning : a.endReason ? ruleWords(a.endReason) : ''}</p>
      {result && <p>{result}</p>}
    </li>
  )
}

function Verification({ task }: { task: TaskCardData }): React.JSX.Element {
  const verdict = verificationVerdict(task.verification)
  if (!verdict) return <p className="task-card__meta">{TL.notChecked}</p>
  return <p data-verdict={verdict}>{verdict === 'passed' ? TL.checksPassed : TL.checksFailed}{outcomeText(task.verification) ? `: ${outcomeText(task.verification)}` : ''}</p>
}

function HistoryRow({ ev }: { ev: WorkEventView }): React.JSX.Element {
  return (
    <li className="task-detail__event">
      <time dateTime={new Date(ev.at).toISOString()} className="task-card__meta">{when(ev.at)}</time>
      <p><strong>{actorWords(ev.actor)}</strong> {eventWords(ev)}</p>
      {(ev.rule || ev.reason) && <p className="task-card__meta">{[ev.rule && ruleWords(ev.rule), ev.reason].filter(Boolean).join(' · ')}</p>}
    </li>
  )
}

/** Side panel with a task's contract, attempts, verification, review checks and full history. */
export function TaskDetail({ client, taskId, refreshTick, onClose }: TaskDetailProps): React.JSX.Element {
  const { page, error, loadingMore, loadMore, retry } = useTaskDetail(client, taskId, refreshTick)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const loaded = page !== null
  useEffect(() => { if (loaded) headingRef.current?.focus() }, [loaded])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
  }

  return (
    <aside className="task-detail" aria-label={TL.detail} onKeyDown={onKeyDown}>
      <div className="task-detail__head">
        <h3 ref={headingRef} tabIndex={-1}>{page?.task.title ?? TL.detail}</h3>
        <IconButton label={TL.closeDetail} size="icon-sm" onClick={onClose}><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
      </div>
      <div className="task-detail__body">
        {error && <div role="alert" className="task-board__error">{error} <Button type="button" size="xs" variant="secondary" onClick={retry}>{TL.retry}</Button></div>}
        {!page && !error && <p role="status">{TL.detailLoading}</p>}
        {page && (
          <>
            <p className="task-card__meta">{TL.statuses[page.task.status]}</p>
            <h4>{TL.objective}</h4>
            <p className="task-detail__text">{page.task.objective}</p>
            <h4>{TL.boundaries}</h4>
            {page.task.boundaries?.length
              ? <ul className="task-detail__list">{page.task.boundaries.map((b) => <li key={b}>{b}</li>)}</ul>
              : <p className="task-card__meta">{TL.noBoundaries}</p>}
            <h4>{TL.acceptance}</h4>
            <p>{TL.acceptanceKinds[page.task.acceptance]}</p>
            <h4>{TL.attempts}</h4>
            {page.assignments.length === 0
              ? <p className="task-card__meta">{TL.noAttempts}</p>
              : <ul className="task-detail__list">{page.assignments.map((a) => <Attempt key={a.id} a={a} nodeName={(a.id === page.task.assignment?.id ? page.task.nodeName : null) ?? a.nodeId} />)}</ul>}
            <h4>{TL.verification}</h4>
            <Verification task={page.task} />
            {(page.task.column === 'needs_review' || page.task.column === 'done') && <TaskHealth client={client} taskId={taskId} refreshTick={refreshTick} />}
            <h4>{TL.history}</h4>
            {page.timeline.length === 0
              ? <p className="task-card__meta">{TL.noHistory}</p>
              : <ol className="task-detail__list task-detail__timeline" aria-label={TL.history}>{page.timeline.map((ev) => <HistoryRow key={ev.seq} ev={ev} />)}</ol>}
            {page.hasMoreTimeline && <Button type="button" size="xs" variant="secondary" disabled={loadingMore} onClick={loadMore}>{loadingMore ? TL.loadingMore : TL.loadMore}</Button>}
          </>
        )}
      </div>
    </aside>
  )
}
