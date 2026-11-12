import { useCallback, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import type { GoalCard } from '../../../shared/centralWork'
import { legalGoalActions, type GoalAction } from './planningModel'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { COLUMN_ORDER, goalErrorText } from './taskBoardModel'
import { usePolledPages, useRowActions } from './usePolledPages'

type GoalRowData = GoalCard & { id: string }

const BUSY = { activate: 'Activating…', abandon: 'Abandoning…' } as const
// The reason of a refusal shows in the strip's notice (it survives the reload that remounts the row).
const outcome = (label: string) => ({ label, ok: (ok: boolean) => ok, success: (ok: boolean) => (ok ? 'Done' : `${label} failed`) })

function GoalRow({ goal, busy, onAct }: { goal: GoalRowData; busy: boolean; onAct: (goal: GoalRowData, action: GoalAction) => Promise<boolean> }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const legal = legalGoalActions(goal.status)
  const { done } = goal.counts
  const named = (action: string): string => TL.actionOn(action, goal.statement)
  const activate = useAction(() => onAct(goal, 'activate'), outcome(TL.goalActivate))
  const abandon = useAction(async () => { const ok = await onAct(goal, 'abandon'); setConfirming(false); return ok }, outcome(TL.goalAbandon))
  return (
    <li className="task-goal" data-status={goal.status}>
      <div className="task-goal__line">
        <span className="task-goal__statement" title={goal.statement}>{goal.statement}</span>
        <Badge className="task-badge">{TL.goalStatuses[goal.status]}</Badge>
        <span className="task-card__meta">{goal.projectName}</span>
        {goal.horizon && <span className="task-card__meta">{TL.goalHorizon(goal.horizon)}</span>}
      </div>
      <div className="task-goal__line">
        <progress className="task-goal__bar" aria-label={TL.goalProgressOf(goal.statement)} value={done} max={Math.max(goal.total, 1)} />
        <span>{goal.total > 0 ? TL.goalProgress(done, goal.total) : TL.goalNoTasks}</span>
        <span className="task-card__meta">{COLUMN_ORDER.map((c) => `${TL.columns[c]} ${goal.counts[c]}`).join(' · ')}</span>
        {goal.complete && <span className="task-goal__hint">{TL.goalAllDone}</span>}
        <span className="task-goal__actions">
          {legal.includes('activate') && <ActionButton type="button" size="xs" disabled={busy} aria-label={named(TL.goalActivate)} action={activate} busyLabel={BUSY.activate}>{TL.goalActivate}</ActionButton>}
          {legal.includes('abandon') && !confirming && <Button type="button" size="xs" variant="ghost" disabled={busy} aria-label={named(TL.goalAbandon)} onClick={() => setConfirming(true)}>{TL.goalAbandon}</Button>}
          {legal.includes('abandon') && confirming && (
            <span className="task-goal__actions" role="group" aria-label={TL.goalAbandonConfirm}>
              <span className="task-card__meta">{TL.goalAbandonConfirm}</span>
              <ActionButton type="button" size="xs" variant="destructive" disabled={busy} aria-label={named(TL.goalAbandonYes)} action={abandon} busyLabel={BUSY.abandon}>{TL.goalAbandonYes}</ActionButton>
              <Button type="button" size="xs" variant="secondary" onClick={() => setConfirming(false)}>{TL.cancelNo}</Button>
            </span>
          )}
        </span>
      </div>
      <ActionResult action={activate} />
      <ActionResult action={abandon} />
    </li>
  )
}

export interface GoalsStripProps {
  client: TaskBoardClient
  projectId: string | undefined
  visible: boolean
  /** Runs after an action, since a goal's move can change its tasks. */
  onChanged: () => void
}

/** Goals of the selected project above the board, with progress and the moves legal for each. Hidden without goals. */
export function GoalsStrip({ client, projectId, visible, onChanged }: GoalsStripProps): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  const feed = usePolledPages<GoalRowData>(async (range, signal) => {
    const page = await client.listGoals(projectId, range, signal)
    return { ...page, items: page.items.map((g) => ({ ...g, id: `${g.projectId}:${g.version}` })) }
  }, projectId, visible, TL.goalsFailed)
  const { refresh } = feed
  const reload = useCallback(() => { refresh(); onChanged() }, [refresh, onChanged])
  const { busy, notice, run } = useRowActions(reload, goalErrorText)
  const act = (goal: GoalRowData, action: GoalAction): Promise<boolean> =>
    run(goal.id, () => (action === 'activate' ? client.activateGoal(goal.projectId, goal.version) : client.abandonGoal(goal.projectId, goal.version)))

  if (feed.loading) return <p className="task-plan__state">{TL.goalsLoading}</p>
  const failure = feed.error && (
    <p role="alert" className="task-board__error">
      {feed.error} <Button type="button" size="xs" variant="secondary" onClick={refresh}>{TL.retry}</Button>
    </p>
  )
  if (!feed.page) return <div className="task-plan__state">{failure}</div>
  if (feed.page.items.length === 0 && !failure) return null
  return (
    <section className="task-goals" aria-label={TL.goals}>
      <Button type="button" size="xs" variant="ghost" aria-expanded={open} aria-label={open ? TL.collapseColumn(TL.goals) : TL.expandColumn(TL.goals)} onClick={() => setOpen((o) => !o)}>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />{TL.goals} ({feed.page.items.length}{feed.page.hasMore ? '+' : ''})
      </Button>
      {failure}
      {notice && <p role="alert" className="task-board__error">{notice}</p>}
      {open && (
        <ul className="task-plan__list">
          {feed.page.items.map((goal) => <GoalRow key={goal.id} goal={goal} busy={busy.has(goal.id)} onAct={act} />)}
        </ul>
      )}
      {open && feed.page.hasMore && (
        <Button type="button" size="xs" variant="secondary" disabled={feed.loadingMore} aria-label={`${TL.loadMore}: ${TL.goals}`} onClick={feed.loadMore}>
          {feed.loadingMore ? TL.loadingMore : TL.loadMore}
        </Button>
      )}
    </section>
  )
}
