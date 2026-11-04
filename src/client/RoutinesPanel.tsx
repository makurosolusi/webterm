// Routines section of Settings › Control (F4-a): agent runs fired by a schedule, a Senses event or
// the API, with a shell precheck, a daily budget and a history that keeps skipped runs and why.
// Imitates Orca automations and Claude Code Desktop scheduled tasks (list, Run now, history).
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fetchWorkspaces, TOKEN_HEADER } from './api'
import { EMPTY_ROUTINE, RoutinesForm, type RoutineDef } from './RoutinesForm'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'
import { peekToken } from './transportToken'

export const ROUTINES_PATH = '/api/routines'

export interface RoutineRun { id: string; trigger: string; status: 'running' | 'ran' | 'skipped' | 'failed'; reason: string | null; startedAt: number; costUsd: number | null
  /** Cost-oracle estimate taken before the run (median of similar past runs); null = no history. */
  estimateUsd?: number | null }
export interface RoutineView extends RoutineDef { id: string; tier: string; nextRunAt: number | null; lastRun: RoutineRun | null }
interface Template { id: string; name: string; description: string; input: Omit<RoutineDef, 'workspaceId' | 'enabled'> }
interface ListView { routines: RoutineView[]; templates: Template[] }

export const ROUTINES_TEXT = {
  title: 'Routines',
  intro: 'Run an agent on a schedule, when an event happens, or from a script. The precheck runs first: a non-zero exit skips the run and spends no tokens. Missed runs while the machine slept collapse into one catch-up run.',
  loading: 'Loading routines…', loadFailed: 'Cannot load routines.', empty: 'No routines yet.',
  add: 'New routine', fromTemplate: 'Start from a template…',
  runNow: 'Run now', edit: 'Edit', delete: 'Delete', history: 'History', hideHistory: 'Hide history', enabled: 'Enabled',
  never: 'never ran', next: (at: number) => `next ${new Date(at).toLocaleString()}`,
  historyEmpty: 'No runs yet.', failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const
const T = ROUTINES_TEXT

async function request(method: string, path = ROUTINES_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const triggerText = (r: RoutineDef): string =>
  r.trigger.type === 'schedule' ? `cron ${r.trigger.cron}` : r.trigger.type === 'event' ? `on ${r.trigger.pattern}` : 'API / manual'
const money = (usd: number): string => `$${usd.toFixed(2)}`
/** ` · $spent · est. $estimate`, each part only when known. */
export const costText = (run: Pick<RoutineRun, 'costUsd' | 'estimateUsd'>): string =>
  [run.costUsd != null ? money(run.costUsd) : '', run.estimateUsd != null ? `est. ${money(run.estimateUsd)}` : ''].filter(Boolean).map((s) => ` · ${s}`).join('')
const runText = (run: RoutineRun): string =>
  `${new Date(run.startedAt).toLocaleString()} · ${run.trigger} · ${run.status}${run.reason ? ` — ${run.reason}` : ''}${costText(run)}`
const toDef = ({ name, enabled, workspaceId, trigger, precheck, action, budget }: RoutineDef): RoutineDef => ({ name, enabled, workspaceId, trigger, precheck, action, budget })

export function RoutinesPanel(): React.JSX.Element {
  const [view, setView] = useState<ListView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  const [editing, setEditing] = useState<{ id: string | null; def: RoutineDef } | null>(null)
  const [history, setHistory] = useState<{ id: string; runs: RoutineRun[] } | null>(null)

  const load = useCallback(() => {
    request('GET')
      .then((v) => { if (v && Array.isArray((v as ListView).routines)) { setView(v as ListView); setLoadError(false) } else setLoadError(true) })
      .catch(() => setLoadError(true)) // shown as the loadFailed note
  }, [])
  useEffect(() => {
    load()
    fetchWorkspaces().then((ws) => setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name })))).catch(() => setWorkspaces([])) // home folder only
  }, [load])

  const act = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try { await fn(); load() } catch (err) { setError(T.failed(what, err instanceof Error ? err.message : String(err))) }
  }
  const save = (def: RoutineDef): void => {
    const id = editing?.id
    void act(T.edit, async () => {
      await (id ? request('PUT', `${ROUTINES_PATH}/${encodeURIComponent(id)}`, def) : request('POST', ROUTINES_PATH, def))
      setEditing(null)
    })
  }
  const showHistory = (id: string): void => {
    if (history?.id === id) { setHistory(null); return }
    void act(T.history, async () => {
      const out = await request('GET', `${ROUTINES_PATH}/${encodeURIComponent(id)}/runs?limit=20`) as { runs: RoutineRun[] }
      setHistory({ id, runs: out.runs })
    })
  }

  return (
    <section aria-label={T.title} data-testid="routines-panel">
      <h3 className="font-semibold">{T.title}</h3>
      <p className="text-xs opacity-70">{T.intro}</p>
      {loadError ? <p className="text-xs opacity-70">{T.loadFailed}</p> : null}
      {!view && !loadError ? <p role="status" className="text-xs opacity-70">{T.loading}</p> : null}
      {view?.routines.length === 0 ? <p className="text-xs opacity-70">{T.empty}</p> : null}
      {view && view.routines.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {view.routines.map((r) => (
            <li key={r.id} data-routine={r.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <SettingsCheckbox ariaLabel={`${T.enabled}: ${r.name}`} checked={r.enabled}
                  onChange={(enabled) => void act(T.edit, () => request('PUT', `${ROUTINES_PATH}/${encodeURIComponent(r.id)}`, { ...toDef(r), enabled }))} />
                <strong className="flex-1">{r.name}</strong>
                <span className="opacity-70">{triggerText(r)} · {r.tier}{r.nextRunAt ? ` · ${T.next(r.nextRunAt)}` : ''}</span>
                <span className="opacity-70" data-testid="last-run">{r.lastRun ? `${r.lastRun.status}${r.lastRun.reason ? ` — ${r.lastRun.reason}` : ''}${costText(r.lastRun)}` : T.never}</span>
                <Button size="sm" onClick={() => void act(T.runNow, () => request('POST', `${ROUTINES_PATH}/${encodeURIComponent(r.id)}/run`))}>{T.runNow}</Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing({ id: r.id, def: toDef(r) })}>{T.edit}</Button>
                <Button size="sm" variant="secondary" onClick={() => showHistory(r.id)}>{history?.id === r.id ? T.hideHistory : T.history}</Button>
                <Button size="sm" variant="secondary" onClick={() => void act(T.delete, () => request('DELETE', `${ROUTINES_PATH}/${encodeURIComponent(r.id)}`))}>{T.delete}</Button>
              </div>
              {history?.id === r.id ? (
                <ul aria-label={`${T.history}: ${r.name}`} className="ml-4 flex flex-col opacity-80">
                  {history.runs.length === 0 ? <li>{T.historyEmpty}</li> : history.runs.map((run) => <li key={run.id} data-status={run.status}>{runText(run)}</li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view && !editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Button size="sm" onClick={() => setEditing({ id: null, def: EMPTY_ROUTINE })}>{T.add}</Button>
          <SettingsSelect ariaLabel={T.fromTemplate} value="" options={[{ value: '', label: T.fromTemplate }, ...view.templates.map((tpl) => ({ value: tpl.id, label: tpl.name }))]}
            onChange={(id) => {
              const tpl = view.templates.find((x) => x.id === id)
              if (tpl) setEditing({ id: null, def: { ...tpl.input, enabled: true, workspaceId: null } })
            }} />
        </div>
      ) : null}
      {editing ? <RoutinesForm key={editing.id ?? 'new'} initial={editing.def} workspaces={workspaces} onSave={save} onCancel={() => setEditing(null)} /> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
