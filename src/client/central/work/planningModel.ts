import { WORK_TERMINAL, type GoalCardStatus, type TaskCard } from '../../../shared/centralWork'
import { TL } from './taskBoardLabels'
import type { CardBadge } from './taskBoardModel'

/** Actions a user can take on a goal. */
export type GoalAction = 'activate' | 'abandon'

/** Which goal actions the server accepts from a status. */
export function legalGoalActions(status: GoalCardStatus): readonly GoalAction[] {
  if (status === 'proposed') return ['activate']
  return status === 'active' ? ['abandon'] : []
}

/** "Due in 3h", or "Overdue" once the moment has passed. */
export function dueWords(at: number, now = Date.now()): string {
  const m = Math.ceil((at - now) / 60_000)
  if (at <= now) return TL.overdue
  if (m < 60) return TL.dueIn(`${m}m`)
  const h = Math.round(m / 60)
  return TL.dueIn(h < 24 ? `${h}h` : `${Math.round(h / 24)}d`)
}

/** Due date badge of an open task. */
export function dueBadge(card: Pick<TaskCard, 'dueAt' | 'status'>, now = Date.now()): CardBadge | null {
  if (card.dueAt === null || WORK_TERMINAL.includes(card.status)) return null
  return { text: dueWords(card.dueAt, now), tone: card.dueAt <= now ? 'error' : 'info' }
}
