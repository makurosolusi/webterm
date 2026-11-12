// Control › Automations (F4-a; moved out of Settings in the settings overhaul): agent runs fired by a schedule,
// a Senses event or the API, with an optional check command, a daily budget and a history that keeps skipped
// runs and why. Templates come first. Imitates Orca automations and Claude Code Desktop scheduled tasks
// (list, Run now, history). One row per routine lives in RoutineRow.tsx.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fetchWorkspaces } from './api'
import { EMPTY_ROUTINE, RoutinesForm, type RoutineAgentNode, type RoutineDef } from './RoutinesForm'
import { RoutineRow, toDef, type RoutineRun, type RoutineView } from './RoutineRow'

export { costText, type RoutineRun, type RoutineView } from './RoutineRow'
export const ROUTINES_PATH = '/api/routines'

interface Template { id: string; name: string; description: string; input: Omit<RoutineDef, 'workspaceId' | 'enabled'> }
interface ListView { routines: RoutineView[]; templates: Template[] }

export const ROUTINES_TEXT = {
  title: 'Routines',
  intro: 'Run an agent on a schedule, when an event happens, or from a script. A routine can first run a check command: if the command fails, the run is skipped and costs nothing. Runs missed while the computer was asleep are made up by a single run.',
  loading: 'Loading routines…', loadFailed: 'Cannot load routines.', empty: 'No routines yet.',
  add: 'New routine', templates: 'Start from a template',
  edit: 'Save', delete: 'Delete', history: 'History', failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const
const T = ROUTINES_TEXT

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
    void act(T.edit, async () => {
      await (id ? request('PUT', at(id), def) : request('POST', ROUTINES_PATH, def))
      setEditing(null)
    })
  }
  const toggleHistory = (id: string): void => {
    if (history?.id === id) { setHistory(null); return }
    void act(T.history, async () => {
      const out = await request('GET', `${at(id, 'runs')}?limit=20`) as { runs: RoutineRun[] }
      setHistory({ id, runs: out.runs })
    })
  }

  return (
    <section aria-label={T.title} data-testid="routines-panel">
      <h3 className="font-semibold">{T.title}</h3>
      <p className="text-xs opacity-70">{T.intro}</p>
      {loadError ? <p className="text-xs opacity-70">{T.loadFailed}</p> : null}
      {!view && !loadError ? <p role="status" className="text-xs opacity-70">{T.loading}</p> : null}
      {view && !editing ? (
        <div className="mt-2 flex flex-col gap-1 text-xs" data-testid="routine-templates">
          <h4 className="font-semibold">{T.templates}</h4>
          <ul className="flex flex-col gap-1">
            {view.templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing({ id: null, def: { ...tpl.input, enabled: true, workspaceId: null } })}>{tpl.name}</Button>
                <span className="opacity-70">{tpl.description}</span>
              </li>
            ))}
          </ul>
          <div><Button size="sm" onClick={() => setEditing({ id: null, def: EMPTY_ROUTINE })}>{T.add}</Button></div>
        </div>
      ) : null}
      {editing ? <RoutinesForm key={editing.id ?? 'new'} initial={editing.def} workspaces={workspaces} agents={agents} onSave={save} onCancel={() => setEditing(null)} /> : null}
      {view?.routines.length === 0 ? <p className="mt-2 text-xs opacity-70">{T.empty}</p> : null}
      {view && view.routines.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
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
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
