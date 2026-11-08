// `/api/routines` (Settings › Automations).
//   GET    /api/routines              routines + last run + templates
//   POST   /api/routines              create
//   PUT    /api/routines/:id          replace the definition
//   DELETE /api/routines/:id          remove (history goes with it)
//   GET    /api/routines/:id/runs     history, newest first (?limit&offset)
//   POST   /api/routines/:id/run      Run now (manual)
//   POST   /api/routines/:id/fire     API trigger (Claude Code routines' POST trigger): root token only
// Everything but `fire` is UI-only like policy rules (policy.api.ts): a routine can spawn agents, so
// an agent credential must never create, edit or start one. `fire` refuses agent credentials too.
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { parseRoutineInput, ROUTINE_TEMPLATES, routineTier } from './routineModel'
import type { RoutinesRuntime } from './routinesRuntime'

export const ROUTINES_PATH = '/api/routines'

export interface RoutinesApiDeps { runtime: RoutinesRuntime; isNodeToken: (token: string) => boolean }
type Result = { status: number; body: unknown }

export function handleRoutinesApi(req: IncomingMessage, url: URL, body: unknown, deps: RoutinesApiDeps): Result {
  const { store, runner, scheduler } = deps.runtime
  const [id, verb, extra] = url.pathname.slice(ROUTINES_PATH.length + 1).split('/').map(decodeURIComponent)
  const method = req.method ?? 'GET'
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial === AGENT_CANNOT_APPROVE) return { status: 403, body: { error: 'agent_cannot_manage_routines' } }
  if (denial && !(verb === 'fire' && method === 'POST')) return { status: 403, body: { error: denial } }
  if (extra !== undefined) return { status: 404, body: { error: 'unknown route' } }

  if (!id) {
    if (method === 'GET') {
      const routines = store.list().map((r) => ({ ...r, tier: routineTier(r.action), lastRun: store.lastRun(r.id) }))
      return { status: 200, body: { routines, templates: ROUTINE_TEMPLATES } }
    }
    if (method === 'POST') {
      const input = parseRoutineInput(body)
      if (typeof input === 'string') return { status: 400, body: { error: input } }
      const routine = store.create(input)
      scheduler.refresh()
      return { status: 201, body: { routine } }
    }
    return { status: 405, body: { error: 'method_not_allowed' } }
  }

  const routine = store.get(id)
  if (!routine) return { status: 404, body: { error: 'routine_not_found' } }
  if (!verb) {
    if (method === 'PUT') {
      const input = parseRoutineInput(body)
      if (typeof input === 'string') return { status: 400, body: { error: input } }
      const updated = store.update(id, input)
      scheduler.refresh()
      return { status: 200, body: { routine: updated } }
    }
    if (method === 'DELETE') {
      store.remove(id)
      scheduler.refresh()
      return { status: 200, body: { ok: true } }
    }
    return { status: 405, body: { error: 'method_not_allowed' } }
  }
  if (verb === 'runs' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return { status: 200, body: { runs: store.runs(id, Number.isFinite(limit) ? limit : 50, Number.isFinite(offset) ? offset : 0) } }
  }
  if ((verb === 'run' || verb === 'fire') && method === 'POST') {
    if (verb === 'fire' && routine.trigger.type !== 'api') return { status: 409, body: { error: 'routine_has_no_api_trigger' } }
    if (verb === 'fire' && !routine.enabled) return { status: 409, body: { error: 'routine_disabled' } }
    const { run } = runner.fire(routine, verb === 'fire' ? 'api' : 'manual')
    return { status: 202, body: { run } }
  }
  return { status: 404, body: { error: 'unknown route' } }
}
