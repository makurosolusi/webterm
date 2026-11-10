import { BOARD_COLUMNS, WORK_TERMINAL, type BoardColumn, type TaskCard, type TaskPage, type WorkEventView, type WorkStatus } from '../../../shared/centralWork'
import { InboxApiError } from '../../inboxTypes'
import { centralErrorMessage } from '../centralLoad'
import { dueBadge } from './planningModel'
import { TL } from './taskBoardLabels'

/** Board columns, left to right. */
export const COLUMN_ORDER = Object.keys(BOARD_COLUMNS) as BoardColumn[]
/** How often a shown board re-reads. */
export const TASK_BOARD_REFRESH_MS = 10_000
/** Server cap on one list request. */
export const TASK_BOARD_MAX_LIMIT = 200

/** A loaded column. */
export type ColumnState = TaskPage
/** One page of a list. */
export interface ListPage<T> { items: T[]; hasMore: boolean }
/** One badge of a card. */
export interface CardBadge { text: string; tone: 'info' | 'warn' | 'error' | 'ok' }
/** Actions a user can take on a task. */
export type TaskAction = 'approve' | 'changes' | 'cancel' | 'retry'

/** Plain English for a rule id; an unknown id is shown as it is. */
export const ruleWords = (rule: string): string => TL.rules[rule] ?? rule

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** Verdict of a stored verification, or null while there is none. */
export function verificationVerdict(verification: unknown): 'passed' | 'failed' | null {
  const passed = asRecord(verification)?.passed
  return typeof passed === 'boolean' ? (passed ? 'passed' : 'failed') : null
}

/** The readable sentence of a verification or an attempt result. */
export function outcomeText(value: unknown): string {
  if (typeof value === 'string') return value
  const rec = asRecord(value)
  const line = rec && [rec.summary, rec.message, rec.reason, rec.error].find((v) => typeof v === 'string' && v !== '')
  if (typeof line === 'string') return line
  return value === null || value === undefined ? '' : JSON.stringify(value)
}

/** Badges of a card, most urgent state first. */
export function cardBadges(card: TaskCard, now = Date.now()): CardBadge[] {
  const badges: CardBadge[] = []
  if (card.status === 'waiting_input') badges.push({ text: TL.needsYou, tone: 'warn' })
  if (card.status === 'stalled') badges.push({ text: card.lastRule ? `${TL.stalled} · ${ruleWords(card.lastRule)}` : TL.stalled, tone: 'warn' })
  if (card.status === 'blocked') badges.push(...(card.blockedBy.length ? card.blockedBy.map((b) => ({ text: TL.blockedBy(b.title), tone: 'info' as const })) : [{ text: TL.blocked, tone: 'info' as const }]))
  if (card.status === 'verifying') badges.push({ text: TL.verifying, tone: 'info' })
  if (card.status === 'failed') badges.push({ text: TL.failed, tone: 'error' })
  if (card.status === 'cancelled') badges.push({ text: TL.cancelled, tone: 'info' })
  const verdict = card.column === 'needs_review' ? verificationVerdict(card.verification) : null
  if (verdict) badges.push(verdict === 'passed' ? { text: TL.checksPassed, tone: 'ok' } : { text: TL.checksFailed, tone: 'error' })
  const due = dueBadge(card, now)
  if (due) badges.push(due)
  if (card.goalVersion != null) badges.push({ text: TL.goalMarker(card.goalVersion), tone: 'info' })
  return badges
}

/** Which actions are legal for a status. */
export function legalActions(status: WorkStatus): ReadonlySet<TaskAction> {
  const legal = new Set<TaskAction>()
  if (status === 'needs_review') { legal.add('approve'); legal.add('changes') }
  if (status === 'failed') legal.add('retry')
  if (!WORK_TERMINAL.includes(status)) legal.add('cancel')
  return legal
}

const AUTH_STATUSES = [401, 403]

/** Readable text for a refused or failed action. */
export function actionErrorText(err: unknown): string {
  return err instanceof InboxApiError && err.code !== 'bad_response' && err.status < 500 && !AUTH_STATUSES.includes(err.status)
    ? TL.actionErrors[err.code] ?? TL.actionRefused(err.code)
    : centralErrorMessage(err, TL.actionFailed)
}

/** Readable text for a refused goal action. */
export function goalErrorText(err: unknown): string {
  return (err instanceof InboxApiError && TL.goalErrors[err.code]) || actionErrorText(err)
}

/** Who did it, in plain words. */
export function actorWords(actor: string): string {
  if (actor.startsWith('agent:')) return TL.agentActor(actor.slice('agent:'.length))
  if (actor.startsWith('human')) return TL.actors.human
  if (actor.startsWith('central')) return TL.actors.central
  return TL.actors.system
}

/** What a timeline event did: a status move, or the kind of event in words. */
export function eventWords(ev: WorkEventView): string {
  if (ev.from && ev.to) return `${TL.statuses[ev.from]} → ${TL.statuses[ev.to]}`
  if (ev.to) return TL.createdAs(TL.statuses[ev.to])
  return TL.eventKinds[ev.kind] ?? ev.kind
}

/** Limit of a background refresh, so pages already loaded stay loaded. */
export const refreshLimit = (loaded: number, page: number): number => Math.min(Math.max(loaded, page), TASK_BOARD_MAX_LIMIT)

/** Adds a "Load more" page; rows a refresh already brought in are not repeated. */
export function appendPage<T extends { id: string }>(column: ListPage<T>, page: ListPage<T>): ListPage<T> {
  const seen = new Set(column.items.map((c) => c.id))
  return { items: [...column.items, ...page.items.filter((c) => !seen.has(c.id))], hasMore: page.hasMore }
}

/** Applies a refreshed head; rows past `limit` stay until they are read again. */
export function mergeRefreshed<T extends { id: string }>(column: ListPage<T> | undefined, page: ListPage<T>, limit: number): ListPage<T> {
  const fresh = new Set(page.items.map((c) => c.id))
  const tail = (column?.items.slice(limit) ?? []).filter((c) => !fresh.has(c.id))
  return { items: [...page.items, ...tail], hasMore: tail.length > 0 ? column?.hasMore ?? page.hasMore : page.hasMore }
}

/** Timeline rows oldest first, one per sequence number; the later copy wins. */
export function mergeTimeline(a: readonly WorkEventView[], b: readonly WorkEventView[]): WorkEventView[] {
  return [...new Map([...a, ...b].map((e) => [e.seq, e])).values()].sort((x, y) => x.seq - y.seq)
}
