// `POST /api/central/tidy/unpark`: the Undo of the "parked finished workers" notice. Like the task board it is a UI path; writes need a `human:*` actor.
import type { RouteResult } from '../apiShared.types'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { UNPARK_PATH } from './agents/agentTidy'

const MAX_IDS = 20
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })

/** Whether `path` is the tidy undo route. */
export const isTidyPath = (path: string): boolean => path === UNPARK_PATH

/** Answers a path `isTidyPath` accepted. */
export async function tidyDispatch(h: Ca2Handle, req: { method: string; body: () => Promise<unknown> }, actor: string): Promise<RouteResult> {
  if (req.method !== 'POST') return fail(405, 'method_not_allowed')
  if (!actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  const ids = ((await req.body()) as { agentIds?: unknown } | null)?.agentIds
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) return fail(400, 'invalid_agent_ids')
  if (!h.tidy) return fail(503, 'tidy_off')
  return { status: 200, body: { unparked: h.tidy.unpark(ids as string[]) } }
}
