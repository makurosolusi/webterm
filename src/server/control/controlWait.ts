// Route `wait` (long-poll in-process). Dipisah dari `controlApi.ts` supaya handler route lain
// tetap di bawah batas 300 baris; tidak ada aturan baru di sini, hanya pemakaian `pollUntil`.

import { isSafeNodeId } from '../../shared/workspace'
import {
  WAIT_MAX_MS,
  asObject,
  type ControlDeps,
  type ControlExit,
  type ControlRequest,
  type ControlResult,
  type ControlSessions,
} from './controlTypes'
import { authorize, badRequest } from './controlAuth'
import { pollUntil } from './waiters'

interface Observation {
  exit?: ControlExit
  status?: ReturnType<ControlSessions['statusOf']>
  output: string
}

const observe = (deps: ControlDeps, id: string): Observation => ({
  exit: deps.sessions.getExit(id),
  status: deps.sessions.statusOf(id),
  output: deps.sessions.getTerminal(id),
})

const WAIT_UNTILS = ['exit', 'status:done', 'idle'] as const
type WaitUntil = (typeof WAIT_UNTILS)[number]

export async function waitRoute(req: ControlRequest, deps: ControlDeps, now: number): Promise<ControlResult> {
  const body = asObject(req.body)
  const nodeId = body.nodeId
  if (!isSafeNodeId(nodeId)) return badRequest('invalid_node_id')
  const auth = authorize(req, deps, now, 'node.wait', `node:${nodeId}`)
  if ('failure' in auth) return auth.failure

  const until = body.until === undefined ? 'exit' : body.until
  if (!WAIT_UNTILS.includes(until as WaitUntil)) return badRequest('invalid_until')
  let timeoutMs = WAIT_MAX_MS
  if (body.timeoutMs !== undefined) {
    const t = body.timeoutMs
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > WAIT_MAX_MS) {
      return badRequest('invalid_timeout')
    }
    timeoutMs = t
  }
  // Node yang tidak pernah hidup dan tidak punya tombstone exit tidak bisa ditunggu.
  if (!deps.sessions.isLive(nodeId) && !deps.sessions.getExit(nodeId)) {
    return { status: 404, body: { error: 'node_not_found' } }
  }

  const isDone = (current: Observation, previous: Observation | undefined): boolean => {
    if (current.exit) return true
    if (until === 'exit') return false
    if (until === 'status:done') return current.status === 'done'
    // `idle` v1: output terminal sama pada dua poll berurutan.
    return previous !== undefined && previous.output === current.output
  }
  const outcome = await pollUntil(() => observe(deps, nodeId), isDone, {
    timeoutMs,
    now: deps.now,
    sleep: deps.sleep,
  })
  const last = outcome.value
  if (last.exit) {
    return {
      status: 200,
      body: {
        state: 'exited',
        exited: { code: last.exit.code, ...(last.exit.reason ? { reason: last.exit.reason } : {}) },
        output: last.output,
      },
    }
  }
  if (outcome.done) {
    return { status: 200, body: { state: until === 'status:done' ? 'done' : 'idle', output: last.output } }
  }
  return { status: 200, body: { state: 'timeout', timeout: true, output: last.output } }
}
