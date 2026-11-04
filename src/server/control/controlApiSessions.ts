// Session-mutating `/api/control/*` routes: spawn, prompt, close. Split out of `controlApi.ts`.
import npath from 'node:path'
import { assembleCmd, isBuiltinAgent, isSafeNodeId } from '../../shared/workspace'
import { spawnAgent } from '../spawn/agentSpawn'
import { authorize, badRequest, capabilityHolder } from './controlAuth'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_PROMPT_CHARS,
  ackKey,
  asObject,
  isValidRequestId,
  positiveInt,
  type AckStore,
  type ControlDeps,
  type ControlRequest,
  type ControlResult,
} from './controlTypes'
import { resolveSpawnSessionId } from './spawnSession'

export async function spawnRoute(req: ControlRequest, deps: ControlDeps, acks: AckStore, now: number): Promise<ControlResult> {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const nodeId = body.nodeId
  if (!isSafeNodeId(nodeId)) return badRequest('invalid_node_id')
  const auth = authorize(req, deps, now, 'node.spawn', `node:${nodeId}`)
  if ('failure' in auth) return auth.failure
  const key = ackKey('node.spawn', nodeId, body.requestId)
  const replay = acks.get(key, now)
  if (replay) return replay

  const agentId = body.agentId
  if (typeof agentId !== 'string' || !isBuiltinAgent(agentId)) return badRequest('invalid_agent_id')
  const cols = body.cols === undefined ? DEFAULT_COLS : positiveInt(body.cols, 500)
  const rows = body.rows === undefined ? DEFAULT_ROWS : positiveInt(body.rows, 500)
  if (cols === undefined || rows === undefined) return badRequest('invalid_size')

  let cwd: string | undefined
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string' || !npath.isAbsolute(body.cwd)) return badRequest('invalid_cwd')
    if (deps.cwdAllowed && !deps.cwdAllowed(body.cwd)) {
      return { status: 403, body: { error: 'cwd_not_allowed' } }
    }
    cwd = body.cwd
  }
  if (deps.sessions.isLive(nodeId)) return { status: 409, body: { error: 'node_exists' } }

  // Session id WAJIB ada untuk agent ber-flag session-id: `launchLine` hanya merakit
  // `--settings`/hook claude bila sessionId hadir. Nilai client diperiksa, bukan dipercaya.
  const sid = resolveSpawnSessionId(agentId, body.sessionId)
  if (!sid.ok) return badRequest('invalid_session_id')

  const cmd = assembleCmd(agentId, deps.settings().agentLaunchCommands[agentId])
  // Thin adapter over `agent.spawn` (F2-h): depth, per-parent cap, lineage (K3) and events live there.
  const spawned = await spawnAgent(
    {
      door: 'control', mode: 'pty', kind: agentId, nodeId, parent: capabilityHolder(auth.record), ...(cwd === undefined ? {} : { cwd }),
      pty: { cmd, agentId, cols, rows, ...(sid.sessionId === undefined ? {} : { sessionId: sid.sessionId }) },
    },
    {
      openPty: (o) =>
        deps.sessions.open(
          { t: 'open', id: o.nodeId, cols, rows, ...(cwd === undefined ? {} : { cwd }), cmd, agentId, ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }) },
          () => {}
        ),
    }
  )
  if (!spawned.ok) return { status: spawned.code === 'spawn_cap_exceeded' ? 429 : spawned.code === 'spawn_invalid' ? 400 : 403, body: { error: spawned.code, message: spawned.message } }
  const result = { status: 201, body: { ok: true, requestId: body.requestId, nodeId } }
  acks.set(key, result, now)
  return result
}

export function promptRoute(
  req: ControlRequest,
  deps: ControlDeps,
  acks: AckStore,
  now: number
): ControlResult {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const nodeId = body.nodeId
  if (!isSafeNodeId(nodeId)) return badRequest('invalid_node_id')
  const auth = authorize(req, deps, now, 'node.prompt', `node:${nodeId}`)
  if ('failure' in auth) return auth.failure
  const key = ackKey('node.prompt', nodeId, body.requestId)
  const replay = acks.get(key, now)
  if (replay) return replay

  if (typeof body.text !== 'string') return badRequest('invalid_text')
  if (body.text.length > MAX_PROMPT_CHARS) {
    return { status: 413, body: { error: 'text_too_large', max: MAX_PROMPT_CHARS } }
  }
  if (body.submit !== undefined && typeof body.submit !== 'boolean') return badRequest('invalid_submit')
  if (!deps.sessions.isLive(nodeId)) return { status: 404, body: { error: 'node_not_found' } }

  deps.sessions.input(nodeId, body.submit === false ? body.text : `${body.text}\r`)
  const result = { status: 200, body: { ok: true, requestId: body.requestId, nodeId } }
  acks.set(key, result, now)
  return result
}

export function closeRoute(
  req: ControlRequest,
  deps: ControlDeps,
  acks: AckStore,
  now: number
): ControlResult {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const nodeId = body.nodeId
  if (!isSafeNodeId(nodeId)) return badRequest('invalid_node_id')
  const auth = authorize(req, deps, now, 'node.close', `node:${nodeId}`)
  if ('failure' in auth) return auth.failure
  const key = ackKey('node.close', nodeId, body.requestId)
  const replay = acks.get(key, now)
  if (replay) return replay

  const live = deps.sessions.isLive(nodeId)
  // Node yang tidak pernah ada: JANGAN panggil `sessions.close`. Tanpa ini, close pada id hantu
  // membuat tombstone exit dan `wait` berikutnya melihat node yang "pernah hidup".
  if (!live && !deps.sessions.getExit(nodeId)) {
    const ghost = { status: 200, body: { ok: true, requestId: body.requestId, nodeId, closed: false } }
    acks.set(key, ghost, now)
    return ghost
  }
  deps.sessions.close(nodeId)
  const result = { status: 200, body: { ok: true, requestId: body.requestId, nodeId, closed: live } }
  acks.set(key, result, now)
  return result
}
