// POST /api/claude-provider/test: the staged Test connection (claudeProvider.connectionTest.ts) of the
// SAVED provider, streamed as NDJSON (one ConnEvent per line, the last one carries `result`), like the
// clone stream of workspaceCreate.route.ts. UI-only, same gate as the rest of the provider API.
// Body `{ request: false }` stops before the request stage (the wizard's check on open spends no tokens).
// One test at a time per server and kind (full / without request): a second request joins the running one.
// The run is killed only when every watcher has left (Cancel = the client drops its request).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { claudeChildEnv } from '../central/runtime/claudeOptions'
import { centralClaudeLaunch, resolveClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import { rememberProviderTest } from './claudeProvider.api'
import { runConnectionTest, type ConnDeps, type ConnEvent, type FinalEvent } from './claudeProvider.connectionTest'
import { claudeEnv, loadConfig, providerView } from './claudeProvider.store'

export const PROVIDER_TEST_PATH = '/api/claude-provider/test'

type Listener = (e: ConnEvent) => void
interface Flight { events: ConnEvent[]; listeners: Set<Listener>; abort: AbortController; done: boolean }
type Kind = 'full' | 'quick'
// ponytail: one flight per kind; per-target flights only if tests of different profiles must run side by side.
// A full click never joins a quick run: it would end without the request it asked for.
const flights: Record<Kind, Flight | null> = { full: null, quick: null }

/** Joins the running test of `kind` or starts one with `start`; `onEvent` gets the replay, then live events. Returns leave(). */
export function joinConnectionTest(kind: Kind, start: (emit: Listener, signal: AbortSignal) => Promise<FinalEvent>, onEvent: Listener): () => void {
  let f = flights[kind]
  if (!f) {
    const created: Flight = { events: [], listeners: new Set(), abort: new AbortController(), done: false }
    f = flights[kind] = created
    const emit: Listener = (e) => { created.events.push(e); for (const l of created.listeners) l(e) }
    void start(emit, created.abort.signal)
      .catch((err: unknown) => emit({ result: 'failed', summary: `The test could not run (${err instanceof Error ? err.message : 'error'}).`, ms: 0, via: '' }))
      .finally(() => { created.done = true; if (flights[kind] === created) flights[kind] = null })
  }
  const joined = f
  for (const e of joined.events) onEvent(e)
  joined.listeners.add(onEvent)
  return () => {
    joined.listeners.delete(onEvent)
    if (joined.listeners.size > 0 || joined.done) return
    joined.abort.abort()
    if (flights[kind] === joined) flights[kind] = null // the next click starts fresh instead of joining a cancelled run
  }
}

export interface ProviderTestDeps extends Partial<Pick<ConnDeps, 'run' | 'onPath' | 'book' | 'now' | 'requestTimeoutMs'>> {
  isNodeToken(token: string): boolean
  /** Drops Central's cached preflight so it sees what this test sees. */
  refreshCentral?(): void
  /** Provider env base (tests inject one; default: Central's scrubbed process env). */
  env?: NodeJS.ProcessEnv
}

const BODY_MAX_BYTES = 1024

/** Answers the route (always true: the path matched). */
export async function streamProviderTest(req: IncomingMessage, res: ServerResponse, url: URL, deps: ProviderTestDeps): Promise<true> {
  const deny = (status: number, error: string): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error }))
    return true
  }
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return deny(403, denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_manage_provider' : denial)
  if (req.method !== 'POST') return deny(405, 'method_not_allowed')
  const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
  if (!read.ok) return deny(read.reason === 'too_large' ? 413 : 400, read.reason)
  let body: unknown
  try { body = read.body === '' ? {} : JSON.parse(read.body) } catch { return deny(400, 'invalid_json') }
  const sendRequest = (body as { request?: unknown } | null)?.request !== false
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const leave = joinConnectionTest(sendRequest ? 'full' : 'quick', (emit, signal) => {
    deps.refreshCentral?.()
    const c = loadConfig()
    const launch = c.mode === 'command' ? resolveClaudeLaunch(c.profileId) : centralClaudeLaunch()
    const { run, onPath, book, now, requestTimeoutMs } = deps
    return runConnectionTest(launch, {
      env: claudeEnv(deps.env ?? claudeChildEnv(process.env)), provider: providerView(), signal, sendRequest,
      ...(run ? { run } : {}), ...(onPath ? { onPath } : {}), ...(book ? { book } : {}), ...(now ? { now } : {}), ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    }, emit).then((final) => {
      // Only a full run is a result for the Doctor/GET; a check without the request proves less.
      if (final.result !== 'ready' && final.failed !== 'cancelled') rememberProviderTest({ ok: final.result === 'ok', message: final.summary, ...(final.stage ? { stage: final.stage } : {}) })
      return final
    })
  }, (e) => {
    if (res.writableEnded) return
    res.write(`${JSON.stringify(e)}\n`)
    if ('result' in e) res.end()
  })
  res.once('close', leave)
  return true
}
