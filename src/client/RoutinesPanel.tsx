// Control › Automations (F4-a; moved out of Settings in the settings overhaul): agent runs fired by a schedule,
// a Senses event or the API, with an optional check command, a daily budget and a history that keeps skipped
// runs and why. Layout follows GitHub Actions / Zapier / Cursor automations: heading row with the primary
// action on the right, the user's own routines first, templates as stacked cards (suggestions under the empty
// state, collapsed under "Templates" once routines exist), details behind an (i) popover. Rows: RoutineRow.tsx.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { VscodePopover } from './components/vscode/vscodePopover'
import { fetchWorkspaces } from './api'
import { EMPTY_ROUTINE, RoutinesForm, type RoutineAgentNode, type RoutineDef } from './RoutinesForm'
import { RoutineRow, toDef, type RoutineRun, type RoutineView } from './RoutineRow'

export { costText, type RoutineRun, type RoutineView } from './RoutineRow'
export const ROUTINES_PATH = '/api/routines'

interface Template { id: string; name: string; description: string; input: Omit<RoutineDef, 'workspaceId' | 'enabled'> }
interface ListView { routines: RoutineView[]; templates: Template[] }

export const ROUTINES_TEXT = {
  title: 'Routines',
  intro: 'Run an agent on a schedule, on an event, or from a script.',
  about: 'About routines',
  details: [
    'A routine can first run a check command: if it fails, the run is skipped and costs nothing.',
    'Runs missed while the computer was asleep are made up by a single run.',
    'Each routine has a daily limit on runs and spend, and keeps a history of every run, skipped ones included.',
  ],
  loading: 'Loading routines…', loadFailed: 'Cannot load routines.', retry: 'Retry', empty: 'No routines yet.',
  emptyHint: 'Start from a template, or create one with New routine.',
  add: 'New routine', templates: 'Templates', useTemplate: 'Use template',
  edit: 'Save', delete: 'Delete', history: 'History', failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const
const T = ROUTINES_TEXT
/** Reset browser list padding (the cause of the indented rows in a sibling panel). */
const LIST = 'm-0 flex min-w-0 list-none flex-col gap-2 p-0'

async function request(method: string, path = ROUTINES_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}
const at = (id: string, verb = ''): string => `${ROUTINES_PATH}/${encodeURIComponent(id)}${verb ? `/${verb}` : ''}`

export function RoutinesPanel(): React.JSX.Element {
  const [view, setView] = useState<ListView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  const [agents, setAgents] = useState<RoutineAgentNode[]>([])
  const [editing, setEditing] = useState<{ id: string | null; def: RoutineDef } | null>(null)
  const [history, setHistory] = useState<{ id: string; runs: RoutineRun[] } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    request('GET')
      .then((v) => { if (v && Array.isArray((v as ListView).routines)) { setView(v as ListView); setLoadError(false) } else setLoadError(true) })
      .catch(() => setLoadError(true)) // shown as the loadFailed note
  }, [])
  useEffect(() => {
    load()
    fetchWorkspaces().then((ws) => {
      setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name })))
      setAgents(ws.flatMap((w) => (w.nodes ?? []).filter((n) => n.kind === 'agent' || n.kind === 'agentChat')
        .map((n) => ({ id: n.id, title: n.title || n.id, workspaceId: w.id, workspaceName: w.name }))))
    }).catch(() => { setWorkspaces([]); setAgents([]) }) // home folder only, no agent picker
  }, [load])

  const act = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try { await fn(); load() } catch (err) { setError(T.failed(what, err instanceof Error ? err.message : String(err))) }
  }
  const save = (def: RoutineDef): void => {
    const id = editing?.id
    setSaving(true)
    void act(T.edit, async () => {
      await (id ? request('PUT', at(id), def) : request('POST', ROUTINES_PATH, def))
      setEditing(null)
    }).finally(() => setSaving(false))
  }
  const toggleHistory = (id: string): void => {
    if (history?.id === id) { setHistory(null); return }
    void act(T.history, async () => {
      const out = await request('GET', `${at(id, 'runs')}?limit=20`) as { runs: RoutineRun[] }
      setHistory({ id, runs: out.runs })
    })
  }

  const startFrom = (tpl: Template): void => setEditing({ id: null, def: { ...tpl.input, enabled: true, workspaceId: null } })
  const hasRoutines = (view?.routines.length ?? 0) > 0
  const templates = view && view.templates.length > 0 ? <TemplateCards templates={view.templates} onUse={startFrom} /> : null

  return (
    <section aria-label={T.title} data-testid="routines-panel" className="flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="routines-heading">
        <h3 className="m-0 font-semibold">{T.title}</h3>
        <About />
        {view && !editing ? <Button size="sm" className="ml-auto" onClick={() => setEditing({ id: null, def: EMPTY_ROUTINE })}>{T.add}</Button> : null}
      </div>
      <p className="m-0 opacity-70" data-testid="routines-intro">{T.intro}</p>
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <span>{T.loadFailed}</span>
          <Button size="sm" variant="secondary" onClick={() => { setLoadError(false); load() }}>{T.retry}</Button>
        </div>
      ) : null}
      {!view && !loadError ? <p role="status" className="m-0 opacity-70">{T.loading}</p> : null}
      {editing ? <RoutinesForm key={editing.id ?? 'new'} initial={editing.def} workspaces={workspaces} agents={agents} saving={saving} onSave={save} onCancel={() => setEditing(null)} /> : null}
      {view && !hasRoutines && !editing ? (
        <div className="flex min-w-0 flex-col gap-2" data-testid="routines-empty">
          <div className="rounded border border-dashed p-3 text-center">
            <p className="m-0 font-semibold">{T.empty}</p>
            <p className="m-0 opacity-70">{T.emptyHint}</p>
          </div>
          {templates}
        </div>
      ) : null}
      {view && hasRoutines ? (
        <ul className={LIST} data-testid="routines-list">
          {view.routines.map((r) => (
            <RoutineRow key={r.id} r={r} history={history?.id === r.id ? history.runs : null}
              run={async () => { const out = await request('POST', at(r.id, 'run')); load(); return out }}
              setEnabled={(enabled) => void act(T.edit, () => request('PUT', at(r.id), { ...toDef(r), enabled }))}
              edit={() => setEditing({ id: r.id, def: toDef(r) })}
              toggleHistory={() => toggleHistory(r.id)}
              remove={() => void act(T.delete, () => request('DELETE', at(r.id)))} />
          ))}
        </ul>
      ) : null}
      {view && hasRoutines && !editing && templates ? (
        <details className="min-w-0" data-testid="routine-templates-more">
          <summary className="cursor-pointer font-semibold">{T.templates}</summary>
          <div className="mt-2">{templates}</div>
        </details>
      ) : null}
      {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
    </section>
  )
}

/** Templates as stacked cards: name, a wrapping one-line description, and the action inside each card. */
function TemplateCards({ templates, onUse }: { templates: Template[]; onUse(tpl: Template): void }): React.JSX.Element {
  return (
    <ul className={LIST} aria-label={T.templates} data-testid="routine-templates">
      {templates.map((tpl) => (
        <li key={tpl.id} data-template={tpl.id} className="flex min-w-0 flex-col items-start gap-1 rounded border p-2">
          <strong className="max-w-full break-words">{tpl.name}</strong>
          <span className="max-w-full break-words opacity-70">{tpl.description}</span>
          <Button size="sm" variant="outline" aria-label={`${T.useTemplate}: ${tpl.name}`} onClick={() => onUse(tpl)}>{T.useTemplate}</Button>
        </li>
      ))}
    </ul>
  )
}

/** (i) next to the heading: what the one-line intro leaves out. */
function About(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  return (
    <span ref={ref} className="inline-flex">
      <IconButton label={T.about} size="icon-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="codicon codicon-info" aria-hidden />
      </IconButton>
      {open && ref.current ? (
        <VscodePopover anchor={ref.current} open onOpenChange={setOpen} ariaLabel={T.about} className="max-w-[min(320px,calc(100vw-16px))] p-2 text-xs">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4">{T.details.map((d) => <li key={d}>{d}</li>)}</ul>
        </VscodePopover>
      ) : null}
    </span>
  )
}
