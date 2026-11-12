// One routine in Control › Automations (RoutinesPanel): on/off, what starts it, the last run in plain words,
// Run now (busy -> "Started" + time, failure with Retry), Edit, History and Delete (asks first).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import type { RoutineDef } from './RoutinesForm'
import { SettingsCheckbox } from './SettingsControls'
import { eventText, scheduleText } from './routineSchedule.presets'

export interface RoutineRun { id: string; trigger: string; status: 'running' | 'ran' | 'skipped' | 'failed'; reason: string | null; startedAt: number; costUsd: number | null
  /** Cost-oracle estimate taken before the run (median of similar past runs); null = no history. */
  estimateUsd?: number | null }
export interface RoutineView extends RoutineDef { id: string; tier: string; nextRunAt: number | null; lastRun: RoutineRun | null }

export const ROUTINE_ROW_TEXT = {
  runNow: 'Run now', starting: 'Starting…', started: 'Started', edit: 'Edit', delete: 'Delete', history: 'History', hideHistory: 'Hide history',
  enabled: 'Enabled', never: 'Never ran', next: (at: number) => `next ${new Date(at).toLocaleString()}`, historyEmpty: 'No runs yet.',
  deleteAsk: (name: string) => `Delete “${name}”? Its history goes too.`, cancel: 'Cancel',
  status: { running: 'Running', ran: 'Ran', skipped: 'Skipped', failed: 'Failed' } as Record<RoutineRun['status'], string>,
  /** Server `RunTrigger` (routineModel.ts) in words. */
  trigger: { schedule: 'on schedule', catch_up: 'made up for a missed run', event: 'after an event', api: 'from a script', manual: 'by hand' } as Record<string, string>,
} as const
const T = ROUTINE_ROW_TEXT

const money = (usd: number): string => `$${usd.toFixed(2)}`
/** ` · $spent · est. $estimate`, each part only when known. */
export const costText = (run: Pick<RoutineRun, 'costUsd' | 'estimateUsd'>): string =>
  [run.costUsd != null ? money(run.costUsd) : '', run.estimateUsd != null ? `est. ${money(run.estimateUsd)}` : ''].filter(Boolean).map((s) => ` · ${s}`).join('')
/** "Skipped, made up for a missed run — check failed · $0.12": status and trigger in words, never raw codes. */
export const runText = (run: RoutineRun): string =>
  `${T.status[run.status] ?? run.status}, ${T.trigger[run.trigger] ?? run.trigger}${run.reason ? ` — ${run.reason}` : ''}${costText(run)}`
export const triggerText = (r: RoutineDef): string =>
  r.trigger.type === 'schedule' ? scheduleText(r.trigger.cron) : r.trigger.type === 'event' ? `When: ${eventText(r.trigger.pattern)}` : 'By hand or from a script'
export const toDef = ({ name, enabled, workspaceId, trigger, precheck, action, budget }: RoutineDef): RoutineDef => ({ name, enabled, workspaceId, trigger, precheck, action, budget })

const runOf = (v: unknown): RoutineRun | undefined => (v && typeof v === 'object' ? (v as { run?: RoutineRun }).run : undefined)

export interface RoutineRowProps {
  r: RoutineView
  history: RoutineRun[] | null
  run(): Promise<unknown>
  setEnabled(on: boolean): void
  edit(): void
  toggleHistory(): void
  remove(): void
}

export function RoutineRow({ r, history, run, setEnabled, edit, toggleHistory, remove }: RoutineRowProps): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  // The server answers with the run it made: "Started", or why it was skipped (check failed, cap reached…).
  const runNow = useAction(run, {
    label: `${T.runNow}: ${r.name}`,
    success: (v) => { const x = runOf(v); return x && x.status !== 'running' && x.status !== 'ran' ? runText(x) : T.started },
    ok: (v) => runOf(v)?.status !== 'failed',
  })
  return (
    <li data-routine={r.id} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsCheckbox ariaLabel={`${T.enabled}: ${r.name}`} checked={r.enabled} onChange={setEnabled} />
        <strong className="flex-1">{r.name}</strong>
        <span className="opacity-70">{triggerText(r)}{r.nextRunAt ? ` · ${T.next(r.nextRunAt)}` : ''}</span>
        <span className="opacity-70" data-testid="last-run">{r.lastRun ? runText(r.lastRun) : T.never}</span>
        <ActionButton size="sm" action={runNow} busyLabel={T.starting}>{T.runNow}</ActionButton>
        <Button size="sm" variant="secondary" onClick={edit}>{T.edit}</Button>
        <Button size="sm" variant="secondary" onClick={toggleHistory}>{history ? T.hideHistory : T.history}</Button>
        <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>{T.delete}</Button>
      </div>
      <ActionResult action={runNow} />
      {asking ? (
        <div role="alertdialog" aria-label={T.deleteAsk(r.name)} className="flex items-center gap-2">
          <span>{T.deleteAsk(r.name)}</span>
          <Button size="sm" variant="destructive" onClick={() => { setAsking(false); remove() }}>{T.delete}</Button>
          <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>{T.cancel}</Button>
        </div>
      ) : null}
      {history ? (
        <ul aria-label={`${T.history}: ${r.name}`} className="ml-4 flex flex-col opacity-80">
          {history.length === 0 ? <li>{T.historyEmpty}</li> : history.map((x) => <li key={x.id} data-status={x.status}>{`${new Date(x.startedAt).toLocaleString()} · ${runText(x)}`}</li>)}
        </ul>
      ) : null}
    </li>
  )
}
