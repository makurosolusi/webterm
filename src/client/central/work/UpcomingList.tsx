import { Button } from '@/components/ui/button'
import { dueWords } from './planningModel'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { actionErrorText } from './taskBoardModel'
import { usePolledPages, useRowActions } from './usePolledPages'

/** Pending reminders with Cancel. Hidden when there are none. */
export function UpcomingList({ client, visible }: { client: TaskBoardClient; visible: boolean }): React.JSX.Element | null {
  const feed = usePolledPages((range, signal) => client.listReminders(range, signal), undefined, visible, TL.remindersFailed)
  const { busy, notice, run } = useRowActions(feed.refresh, actionErrorText)
  if (feed.loading) return <p className="task-plan__state">{TL.remindersLoading}</p>
  const failure = feed.error && (
    <p role="alert" className="task-board__error">
      {feed.error} <Button type="button" size="xs" variant="secondary" onClick={feed.refresh}>{TL.retry}</Button>
    </p>
  )
  if (!feed.page) return <div className="task-plan__state">{failure}</div>
  const pending = feed.page.items.filter((r) => r.status === 'pending')
  if (pending.length === 0 && !feed.page.hasMore && !failure && !notice) return null
  return (
    <section className="task-upcoming" aria-label={TL.upcoming}>
      <h3 className="task-upcoming__title">{TL.upcoming}</h3>
      {failure}
      {notice && <p role="alert" className="task-board__error">{notice}</p>}
      <ul className="task-plan__list">
        {pending.map((r) => (
          <li key={r.id} className="task-upcoming__row">
            <span className="task-upcoming__text">{r.text}</span>
            <span className="task-card__meta">{r.projectName}</span>
            <time className="task-card__meta" dateTime={new Date(r.dueAt).toISOString()} title={new Date(r.dueAt).toLocaleString()}>{dueWords(r.dueAt)}</time>
            <Button type="button" size="xs" variant="ghost" disabled={busy.has(r.id)} aria-label={TL.actionOn(TL.cancel, r.text)} onClick={() => void run(r.id, () => client.cancelReminder(r.id))}>{TL.cancel}</Button>
          </li>
        ))}
      </ul>
      {feed.page.hasMore && (
        <Button type="button" size="xs" variant="secondary" disabled={feed.loadingMore} aria-label={`${TL.loadMore}: ${TL.upcoming}`} onClick={feed.loadMore}>
          {feed.loadingMore ? TL.loadingMore : TL.loadMore}
        </Button>
      )}
    </section>
  )
}
