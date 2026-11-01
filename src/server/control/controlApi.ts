// Control API headless (P1). Murni: tidak menyentuh `IncomingMessage`/`ServerResponse`, tidak
// mengimpor `Bun`, dan semua efek samping lewat `deps` (sesi, capability, settings). Integrasi di
// `api.ts` cukup memanggil `handleControl(req, deps)` dan meneruskan hasilnya.
//
// SATU JALUR EXEC: `spawn` memanggil `sessions.open` yang sama dengan WebSocket `open`, sehingga
// tidak ada jalur PTY kedua. `cmd` TIDAK pernah diterima dari body — hanya dari
// `settings.agentLaunchCommands[agentId]` lewat `assembleCmd`.

import npath from 'node:path'
import { assembleCmd, isBuiltinAgent, isSafeNodeId } from '../../shared/workspace'
import { tokensMatch } from '../auth'
import { CAPABILITY_VERBS, isValidResource, type CapabilityVerb } from './capabilities'
import { authenticate, authorize, badRequest, forbidden } from './controlAuth'
import { waitRoute } from './controlWait'
import {
  AckStore,
  CONTROL_PREFIX,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_PROMPT_CHARS,
  ackKey,
  asObject,
  headerValue,
  isValidRequestId,
  positiveInt,
  type ControlDeps,
  type ControlRequest,
  type ControlResult,
} from './controlTypes'
import { resolveSpawnSessionId } from './spawnSession'

/** Satu ack store per objek `deps`, supaya dua server/test yang hidup bersamaan tidak berbagi
 *  jendela replay requestId. `deps` produksi stabil (lihat `mount.ts`), jadi WeakMap ini tidak
 *  membuat store baru tiap request. */
const stores = new WeakMap<ControlDeps, AckStore>()

const storeFor = (deps: ControlDeps): AckStore => {
  let store = stores.get(deps)
  if (!store) {
    store = new AckStore()
    stores.set(deps, store)
  }
  return store
}

function spawnRoute(req: ControlRequest, deps: ControlDeps, acks: AckStore, now: number): ControlResult {
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
  deps.sessions.open(
    {
      t: 'open',
      id: nodeId,
      cols,
      rows,
      ...(cwd === undefined ? {} : { cwd }),
      cmd,
      agentId,
      ...(sid.sessionId === undefined ? {} : { sessionId: sid.sessionId }),
    },
    () => {}
  )
  const result = { status: 201, body: { ok: true, requestId: body.requestId, nodeId } }
  acks.set(key, result, now)
  return result
}

function promptRoute(req: ControlRequest, deps: ControlDeps, acks: AckStore, now: number): ControlResult {
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

function closeRoute(req: ControlRequest, deps: ControlDeps, acks: AckStore, now: number): ControlResult {
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

function nodesRoute(req: ControlRequest, deps: ControlDeps, now: number): ControlResult {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth.failure
  const record = auth.record
  const all = deps.sessions.list()
  // Cek grant atas resource-nya sendiri dulu: tanpa ini, grant `node.spawn` untuk satu node
  // lolos hanya karena daftar sesi kebetulan kosong (tidak ada node untuk difilter).
  if (!deps.capabilities.allows(record, 'node.read', record.resource)) return forbidden.failure
  if (record.resource === '*') return { status: 200, body: all }
  // Grant selain `*` harus menunjuk node; `workspace:`/`project:` tidak memberi daftar node.
  if (!record.resource.startsWith('node:')) return forbidden.failure
  const visible = all.filter((s) => deps.capabilities.allows(record, 'node.read', `node:${s.id}`))
  return { status: 200, body: visible }
}

function planRoute(req: ControlRequest, deps: ControlDeps, now: number): ControlResult {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth.failure
  if (!deps.capabilities.allows(auth.record, 'plan.read', auth.record.resource)) return forbidden.failure
  return { status: 501, body: { error: 'plan_not_available' } }
}

/** Mint hanya untuk root eksplisit: flag fitur + header token root yang cocok. Selain itu route
 *  ini tidak ada (404) atau tertutup (403), bukan 401 — ia bukan jalur kapabilitas node.
 *  Perbandingan memakai `tokensMatch` (constant-time), bukan `!==`. */
function tokenRoute(req: ControlRequest, deps: ControlDeps): ControlResult {
  if (!deps.allowTokenMint || !deps.rootToken || !deps.capabilities.mint) {
    return { status: 404, body: { error: 'not_found' } }
  }
  if (!tokensMatch(deps.rootToken, headerValue(req.headers, 'x-webterm-token'))) {
    return { status: 403, body: { error: 'forbidden' } }
  }
  const body = asObject(req.body)
  const verb = body.verb
  if (typeof verb !== 'string' || !CAPABILITY_VERBS.includes(verb as CapabilityVerb)) {
    return badRequest('invalid_verb')
  }
  const resource = body.resource
  if (typeof resource !== 'string' || !isValidResource(resource)) return badRequest('invalid_resource')
  if (resource === '*' && verb !== 'node.read') return badRequest('invalid_resource')
  let ttlMs: number | undefined
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      return badRequest('invalid_ttl')
    }
    ttlMs = body.ttlMs
  }
  try {
    const minted = deps.capabilities.mint({ verb: verb as CapabilityVerb, resource, ttlMs })
    return { status: 201, body: { token: minted.token, expiresAt: minted.expiresAt } }
  } catch {
    return badRequest('invalid_mint')
  }
}

/**
 * Router keluarga `/api/control/*`. `null` untuk path/method yang bukan miliknya (pemanggil lalu
 * menjatuhkannya ke 404), sehingga integrasi tidak perlu tahu daftar route.
 */
export async function handleControl(req: ControlRequest, deps: ControlDeps): Promise<ControlResult> {
  if (req.path !== CONTROL_PREFIX && !req.path.startsWith(`${CONTROL_PREFIX}/`)) return null
  const method = req.method.toUpperCase()
  const now = (deps.now ?? Date.now)()
  const acks = storeFor(deps)
  const path = req.path

  if (method === 'POST' && path === `${CONTROL_PREFIX}/spawn`) return spawnRoute(req, deps, acks, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/prompt`) return promptRoute(req, deps, acks, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/wait`) return waitRoute(req, deps, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/close`) return closeRoute(req, deps, acks, now)
  if (method === 'GET' && path === `${CONTROL_PREFIX}/nodes`) return nodesRoute(req, deps, now)
  if (method === 'GET' && path === `${CONTROL_PREFIX}/plan`) return planRoute(req, deps, now)
  if (method === 'POST' && path === `${CONTROL_PREFIX}/token`) return tokenRoute(req, deps)
  return null
}
