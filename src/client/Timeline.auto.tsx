// Automatic-action lines of the Activity timeline: the "Automatic" tag and the Undo control an
// `auto.*` event may offer (`payload.undo`). The server records its own event for the undo; the
// "Undone" state here is kept in memory per event so the line reads right until that event lands.
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import type { AutoUndo } from './Timeline.model'

/** Event keys (`s<seq>`) undone in this tab; survives the panel closing and reopening. */
const undone = new Set<string>()

/** Test hook: forget every in-memory "Undone" state. */
export const resetUndone = (): void => undone.clear()

/** POSTs the undo request (same-origin, so the session cookie rides along); throws with the server's reason. */
export async function postUndo(undo: AutoUndo): Promise<void> {
  const res = await fetch(undo.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(undo.body ?? {}),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  const reason = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
  throw new Error(reason)
}

export function AutoTag(): React.JSX.Element {
  return <span className="timeline-auto-tag">Automatic</span>
}

/** Undo button for one automatic line; once it succeeds the button gives way to "Undone". */
export function AutoUndoControl({ eventKey, undo }: { eventKey: string; undo: AutoUndo }): React.JSX.Element {
  const action = useAction(async () => { await postUndo(undo); undone.add(eventKey) }, { label: undo.label, success: () => 'Undone' })
  if (undone.has(eventKey) || action.result?.ok) return <span className="timeline-auto-undone" role="status">Undone</span>
  return (
    <span className="timeline-auto-undo">
      <ActionButton type="button" variant="ghost" size="sm" action={action} busyLabel="Undoing…">{undo.label}</ActionButton>
      <ActionResult action={action} />
    </span>
  )
}
