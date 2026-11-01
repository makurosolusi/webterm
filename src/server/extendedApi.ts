// P3/P4 runtime surfaces behind one narrow mount so `api.ts` grows by exactly one import and one
// call. Only exact families are claimed:
//   /api/central/*            (central thin layer, read + pause/resume/priority)
//   POST /api/orchestrator/run (one production worker run)
//   POST /api/orchestrator/bootstrap|assign (root-only control plane)
//   POST /api/memory/export|rebuild (memory files)
// Everything else returns false and keeps falling through the normal route chain.
//
// Bodies are capped hard (16 KiB) *while streaming* and must be a JSON object. Nothing from the
// body or the auth token is ever logged here; sub-handlers return already-compact responses.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { centralHttpRoute, isCentralPath, type CentralHttpDeps } from './centralHttp'
import { declaredLength, readCappedBody } from './channels/channelHttp'
import {
  memoryFileHttpRoute,
  isMemoryFilePath,
  type MemoryFileHttpDeps,
} from './memoryFileHttp'
import { memoryFilesEnabled } from './memory/memoryFile'
import {
  orchestratorRunRoute,
  orchestratorRunEnabled,
  ORCHESTRATOR_RUN_PATH,
  type OrchestratorRunDeps,
} from './orchestratorRunApi'
import {
  orchestratorAssignRoute,
  orchestratorBootstrapRoute,
  ORCHESTRATOR_ASSIGN_PATH,
  ORCHESTRATOR_BOOTSTRAP_PATH,
  type OrchestratorControlDeps,
} from './orchestratorControlApi'

export const MAX_API_BODY_BYTES = 16 * 1024

export interface ExtendedApiDeps {
  central?: Omit<CentralHttpDeps, 'runtime'>
  orchestrator?: Omit<OrchestratorRunDeps, 'ledger'> & Omit<OrchestratorControlDeps, 'ledger'>
  memory?: Omit<MemoryFileHttpDeps, 'ledger'>
}

type JsonResult = { ok: true; value: Record<string, unknown> } | { ok: false }

/** Empty, array, scalar and malformed text are all "not a JSON object". */
export function parseJsonObject(raw: string): JsonResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false }
  try {
    const value = JSON.parse(trimmed) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export async function extendedApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _readBody: () => Promise<string>,
  ledger: LedgerRuntime | null,
  deps: ExtendedApiDeps = {}
): Promise<boolean> {
  const path = url.pathname
  const method = req.method || 'GET'
  const central = isCentralPath(path)
  const orchestrator =
    path === ORCHESTRATOR_RUN_PATH ||
    path === ORCHESTRATOR_BOOTSTRAP_PATH ||
    path === ORCHESTRATOR_ASSIGN_PATH
  const memory = isMemoryFilePath(path)
  if (!central && !orchestrator && !memory) return false

  // Cap BEFORE buffering anything: a declared oversize is refused without reading a byte, and the
  // streaming reader stops at MAX+1 (then drains), so a chunked multi-GB body is never accumulated.
  // `_readBody` stays only so existing call sites keep compiling; it buffers without bound.
  let raw = ''
  if (method === 'POST') {
    const declared = declaredLength(req.headers['content-length'])
    if (declared !== undefined && declared > MAX_API_BODY_BYTES) {
      req.resume() // drain so keep-alive is not desynced by an unread body
      send(res, 413, { error: 'payload_too_large' })
      return true
    }
    const read = await readCappedBody(req, MAX_API_BODY_BYTES)
    if (!read.ok) {
      // Overflow already dropped the listener and resumed the stream inside the reader.
      if (read.reason === 'too_large') send(res, 413, { error: 'payload_too_large' })
      else send(res, 400, { error: 'body_read_failed' })
      return true
    }
    raw = read.body
  }

  // Flag gates live here so a disabled surface never depends on a valid body. Sub-handlers
  // re-check them; the flags are cheap and process-wide.
  if (orchestrator && !(deps.orchestrator?.enabled ?? orchestratorRunEnabled())) {
    send(res, 503, { error: 'orchestrator_off' })
    return true
  }
  if (memory && !(deps.memory?.enabled ?? memoryFilesEnabled(deps.memory?.env ?? process.env))) {
    send(res, 503, { error: 'memory_files_off' })
    return true
  }
  // Central paths answer GET plus POST mutations; centralRoute owns the exact 405s.

  if (!central && method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed' })
    return true
  }

  let body: Record<string, unknown> | undefined
  if (method === 'POST' && raw.trim() !== '') {
    const parsed = parseJsonObject(raw)
    if (!parsed.ok) {
      send(res, 400, { error: 'invalid_json' })
      return true
    }
    body = parsed.value
  }

  if (central) {
    const result = centralHttpRoute(path, method, url.searchParams, body, {
      ...(deps.central ?? {}),
      runtime: ledger,
    })
    send(res, result?.status ?? 404, result?.body ?? { error: 'unknown_route' })
    return true
  }
  if (orchestrator) {
    const controlDeps = { ...(deps.orchestrator ?? {}), ledger }
    const result =
      path === ORCHESTRATOR_RUN_PATH
        ? await orchestratorRunRoute(body, controlDeps)
        : path === ORCHESTRATOR_BOOTSTRAP_PATH
          ? await orchestratorBootstrapRoute(body, controlDeps)
          : await orchestratorAssignRoute(body, controlDeps)
    send(res, result.status, result.body)
    return true
  }
  const result = await memoryFileHttpRoute(path, method, body, {
    ...(deps.memory ?? {}),
    ledger,
  })
  // `memory` matched a known path, so a null here would be a programming error; answer 404.
  send(res, result?.status ?? 404, result?.body ?? { error: 'unknown_route' })
  return true
}
