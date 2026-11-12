import { useState, type MouseEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Textarea } from '@/components/ui/textarea'
import type { TaskCard as TaskCardData } from '../../../shared/centralWork'
import { focusCanvasNode } from '../../osNotify'
import { relativeTime } from '../../SessionHistory.model'
import { TL } from './taskBoardLabels'
import { cardBadges, legalActions, type TaskAction } from './taskBoardModel'

export interface TaskCardProps {
  card: TaskCardData
  busy: boolean
  refused: string | undefined
  selected: boolean
  onAct: (id: string, action: TaskAction, body?: Record<string, string>) => Promise<boolean>
  onOpen: (id: string) => void
}

const BUSY = { approve: 'Approving…', retry: 'Retrying…', cancel: 'Cancelling…' } as const
// The refusal's reason is the card's `refused` line; the result line adds the time and Retry.
const outcome = (label: string) => ({ label, ok: (ok: boolean) => ok, success: (ok: boolean) => (ok ? 'Done' : `${label} failed`) })

function signalText(card: TaskCardData): string | null {
  if (!card.assignment) return null
  return card.assignment.lastSignalAt === null ? TL.noSignal : TL.active(relativeTime(card.assignment.lastSignalAt))
}

/** One task on the board with its badges and the actions legal for its status. */
export function TaskCard({ card, busy, refused, selected, onAct, onOpen }: TaskCardProps): React.JSX.Element {
  const [mode, setMode] = useState<'idle' | 'note' | 'cancel'>('idle')
  const [note, setNote] = useState('')
  const legal = legalActions(card.status)
  const signal = signalText(card)
  const named = (action: string): string => TL.actionOn(action, card.title)

  const run = async (action: TaskAction, body?: Record<string, string>): Promise<boolean> => {
    const ok = await onAct(card.id, action, body)
    if (ok) { setMode('idle'); setNote('') }
    return ok
  }
  const approve = useAction(() => run('approve'), outcome(TL.approve))
  const retry = useAction(() => run('retry'), outcome(TL.retryTask))
  const cancel = useAction(() => run('cancel'), outcome(TL.cancel))
  const openFromCard = (event: MouseEvent<HTMLElement>): void => {
    if (!(event.target as Element).closest('button, textarea')) onOpen(card.id)
  }

  return (
    <article className="task-card" data-status={card.status} data-selected={selected ? 'true' : undefined} onClick={openFromCard}>
      <Button type="button" variant="ghost" size="sm" className="task-card__title" aria-label={TL.showDetails(card.title)} onClick={() => onOpen(card.id)}>{card.title}</Button>
      <p className="task-card__meta">{card.projectName}</p>
      {card.assignment && (
        <div className="task-card__node">
          <span className="task-card__meta">{card.nodeName ?? TL.unknownNode}</span>
          <Button type="button" size="xs" variant="secondary" disabled={!card.nodeExists} aria-label={named(TL.openNode)} onClick={() => focusCanvasNode(card.assignment!.nodeId)}>{TL.openNode}</Button>
          {!card.nodeExists && <span className="task-card__meta">{TL.nodeGone}</span>}
        </div>
      )}
      <p className="task-card__meta">{TL.created(relativeTime(card.createdAt))}{signal ? ` · ${signal}` : ''}</p>
      {cardBadges(card).length > 0 && (
        <div className="task-card__badges">
          {cardBadges(card).map((b) => <Badge key={b.text} className="task-badge" data-tone={b.tone}>{b.text}</Badge>)}
        </div>
      )}
      {refused && <p role="alert" className="task-board__error">{refused}</p>}
      {mode === 'note' && (
        <form className="task-card__note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run('changes', { note: note.trim() }) }}>
          <Textarea aria-label={named(TL.changesNote)} placeholder={TL.changesNote} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <div className="task-card__actions">
            <Button type="submit" size="xs" disabled={busy || !note.trim()} aria-label={named(TL.sendChanges)}>{TL.sendChanges}</Button>
            <Button type="button" size="xs" variant="secondary" onClick={() => setMode('idle')}>{TL.cancelNo}</Button>
          </div>
        </form>
      )}
      {mode === 'cancel' && (
        <div className="task-card__actions" role="group" aria-label={TL.cancelConfirm}>
          <span className="task-card__meta">{TL.cancelConfirm}</span>
          <ActionButton type="button" size="xs" variant="destructive" disabled={busy} aria-label={named(TL.cancelYes)} action={cancel} busyLabel={BUSY.cancel}>{TL.cancelYes}</ActionButton>
          <Button type="button" size="xs" variant="secondary" onClick={() => setMode('idle')}>{TL.cancelNo}</Button>
        </div>
      )}
      {mode === 'idle' && legal.size > 0 && (
        <div className="task-card__actions">
          {legal.has('approve') && <ActionButton type="button" size="xs" disabled={busy} aria-label={named(TL.approve)} action={approve} busyLabel={BUSY.approve}>{TL.approve}</ActionButton>}
          {legal.has('changes') && <Button type="button" size="xs" variant="secondary" disabled={busy} aria-label={named(TL.requestChanges)} onClick={() => setMode('note')}>{TL.requestChanges}</Button>}
          {legal.has('retry') && <ActionButton type="button" size="xs" disabled={busy} aria-label={named(TL.retryTask)} action={retry} busyLabel={BUSY.retry}>{TL.retryTask}</ActionButton>}
          {legal.has('cancel') && <Button type="button" size="xs" variant="ghost" disabled={busy} aria-label={named(TL.cancel)} onClick={() => setMode('cancel')}>{TL.cancel}</Button>}
        </div>
      )}
      <ActionResult action={approve} />
      <ActionResult action={retry} />
      <ActionResult action={cancel} />
    </article>
  )
}
