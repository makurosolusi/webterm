// P3/P4 runtime surfaces behind one narrow mount so `api.ts` grows by exactly one import and one
// call. Only exact families are claimed:
//   /api/central/*            (central thin layer, read + pause/resume/priority)
//   POST /api/orchestrator/run (one production worker run)
//   POST /api/orchestrator/bootstrap|assign (root-only control plane)
//   POST /api/memory/export|rebuild (memory files)
// Everything else returns false and keeps falling through the normal route chain.
//
// Body intake (16 KiB streaming cap + JSON-object parse) lives in `extendedApiBody` and is
// re-exported here for existing callers. Nothing from the body or the auth token is ever logged
// here; sub-handlers return already-compact responses.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { centralHttpRoute, isCentralPath, type CentralHttpDeps } from './centralHttp'
import {
  memoryFileHttpRoute,
  isMemoryFilePath,
  type MemoryFileHttpDeps,
} from './memoryFileHttp'
import { memoryFilesEnabled } from './memory/memoryFile'
import { parseJsonObject, readBoundedBody } from './extendedApiBody'
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

export { MAX_API_BODY_BYTES, parseJsonObject } from './extendedApiBody'

export interface ExtendedApiDeps {
  central?: Omit<CentralHttpDeps, 'runtime'>
  orchestrator?: Omit<OrchestratorRunDeps, 'ledger'> & Omit<OrchestratorControlDeps, 'ledger'>
  memory?: Omit<MemoryFileHttpDeps, 'ledger'>
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

  const read = await readBoundedBody(req, method)
  if (!read.ok) {
    send(res, read.status, { error: read.error })
    return true
  }
  const raw = read.raw

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
