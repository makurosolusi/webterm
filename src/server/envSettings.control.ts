// `/api/control/effective` (Control tab, F0-c read model + F1-f writes + Doctor). One path because
// featureCapabilities.api.ts mounts exactly this path ahead of the /api/control/* family:
//   GET               effective config (every knob: value, source, reason, UI location, lock)
//   PUT {set, unset}  write Control-owned knobs; shell-env and locked keys are refused (409)
//   GET ?doctor=1     Doctor checks;  POST {fix: id}  apply one safe Doctor fix
// `/api/control/doctor` is the Doctor's own path (GET checks, POST {fix: id}); the query form above stays.
// Root-only (`rootReader`), and mutations additionally pass the settings guard and are audited.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CAPABILITY_HEADER, TOKEN_HEADER, tokensMatch } from './auth'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { fixDoctor, isDoctorId, runDoctor, type DoctorDeps } from './doctor'
import { getDotenvBoot } from './dotenvFiles'
import { buildEffectiveConfig, type EffectiveConfig } from './effectiveConfig'
import { BOOTSTRAP_ONLY_KEYS } from './envRegistry'
import type { EnvChange, EnvSettings } from './envSettings.service'
import type { AuditEntry } from './featureCapabilities.audit'
import { peerOf, settingsGuard, type GuardResult } from './featureCapabilities.guard'
import { firstHeader } from './httpHeaders'
import { createLogger } from './logs'
import { getTokenState } from './tokenBootstrap'

const log = createLogger('settings')
export const CONTROL_EFFECTIVE_PATH = '/api/control/effective'
export const CONTROL_DOCTOR_PATH = '/api/control/doctor'
const OWNER_CTX = { root: true }
const SANDBOX_KEY = 'WEBTERM_AGENT_SANDBOX'

export interface ControlDeps {
  service: EnvSettings
  env?: NodeJS.ProcessEnv
  dotenvKeys?: ReadonlySet<string>
  /** undefined = live token state; null = loopback mode without a root token. */
  rootToken?: string | null
  guard?(req: IncomingMessage): GuardResult
  audit?(entry: AuditEntry): void
  /** Doctor dependencies; default = real wiring (doctor.runtime.ts). */
  doctor?(model: EffectiveConfig): DoctorDeps
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Body shape `{ set?: {KEY: string}, unset?: KEY[] }`, or null when malformed. */
export function parseChange(body: unknown): EnvChange | null {
  if (!isRecord(body)) return null
  const { set = {}, unset = [] } = body
  if (!isRecord(set) || !Array.isArray(unset) || !unset.every((k) => typeof k === 'string')) return null
  return { set, unset: unset as string[] }
}

/** Owner only: /api/control/* also admits node/capability tokens, so both are refused; with a root token set it
 *  must be presented, without one (loopback mode) any presented token is a node token. */
export function rootReader(req: IncomingMessage, rootToken: string | undefined = getTokenState().token): boolean {
  if (firstHeader(req.headers?.[CAPABILITY_HEADER])) return false
  const presented = firstHeader(req.headers?.[TOKEN_HEADER]) || undefined
  return rootToken === undefined ? presented === undefined : presented !== undefined && tokensMatch(rootToken, presented)
}

const model = (d: ControlDeps): EffectiveConfig => buildEffectiveConfig({
  state: d.service.state(OWNER_CTX), env: d.env ?? process.env,
  dotenvKeys: d.dotenvKeys ?? getDotenvBoot().keys, bootstrapKeys: BOOTSTRAP_ONLY_KEYS,
})

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const read = await readCappedRequestBody(req, SETTINGS_BODY_MAX_BYTES)
  if (!read.ok) {
    json(res, read.reason === 'too_large' ? 413 : 400, { error: read.reason === 'too_large' ? 'payload_too_large' : 'body_read_failed' })
    return { ok: false }
  }
  try { return { ok: true, value: read.body.trim() === '' ? {} : JSON.parse(read.body) } } catch { json(res, 400, { error: 'bad_json' }); return { ok: false } } // reported, not swallowed
}

/** Audit without the value; a failed audit write never undoes a valid mutation, it is only warned. */
async function audit(d: ControlDeps, req: IncomingMessage, entry: Pick<AuditEntry, 'action' | 'via' | 'detail'>): Promise<void> {
  try {
    // featureCapabilities.api.ts passes only the service; the real audit sink lives with the DB wiring.
    const sink = d.audit ?? (await import('./envSettings.runtime')).envSettingsApiDeps().audit
    sink?.({ capability: 'advanced', peer: peerOf(req), ...entry })
  } catch (err) {
    log.warn('audit.write_failed', 'Cannot write control audit row', { cause: err instanceof Error ? err.name : 'error' })
  }
}

async function doctorDepsOf(d: ControlDeps, m: EffectiveConfig): Promise<DoctorDeps> {
  if (d.doctor) return d.doctor(m)
  const { doctorDeps } = await import('./doctor.runtime')
  const sandboxLock = m.rows.find((r) => r.key === SANDBOX_KEY)?.lockReason
  return doctorDeps({ service: d.service, env: d.env ?? process.env, ...(sandboxLock ? { sandboxLock } : {}) })
}

/** Writes only keys the Control tab owns and may write; everything else is named in the error. */
async function write(req: IncomingMessage, res: ServerResponse, d: ControlDeps, via: 'ui' | 'token'): Promise<void> {
  const body = await readJson(req, res)
  if (!body.ok) return
  const change = parseChange(body.value)
  if (!change) return json(res, 400, { error: 'invalid_body' })
  const rows = new Map(model(d).rows.map((r) => [r.key, r]))
  for (const key of [...Object.keys(change.set), ...change.unset]) {
    const row = rows.get(key)
    if (!row) return json(res, 400, { error: 'unknown_key', key })
    if (!row.editable) return json(res, 409, { error: row.lockReason ? 'locked' : 'managed_elsewhere', key, reason: row.lockReason ?? `Managed in ${row.ui}.` })
  }
  const result = d.service.update(change, OWNER_CTX)
  if (!result.ok) return json(res, result.status, { error: result.error, key: result.key, reason: result.reason })
  await audit(d, req, { action: 'advanced', via, detail: [...Object.keys(change.set), ...change.unset].join(',') })
  json(res, 200, { ...model(d), restartRequired: result.restartRequired })
}

async function fix(req: IncomingMessage, res: ServerResponse, d: ControlDeps, via: 'ui' | 'token'): Promise<void> {
  const body = await readJson(req, res)
  if (!body.ok) return
  const id = isRecord(body.value) ? body.value['fix'] : undefined
  if (!isDoctorId(id)) return json(res, 400, { error: 'invalid_body' })
  try {
    const out = await fixDoctor(id, await doctorDepsOf(d, model(d)))
    if (!out.ok) return json(res, 409, { error: out.error })
    await audit(d, req, { action: 'advanced', via, detail: `doctor:${id}` })
    json(res, 200, out.check)
  } catch (err) {
    log.warn('doctor.fix_failed', 'Doctor fix failed', { id, cause: err instanceof Error ? err.message : 'error' })
    json(res, 500, { error: 'fix_failed' })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, method: string, d: ControlDeps, doctorPath: boolean): Promise<void> {
  const root = d.rootToken === undefined ? rootReader(req) : rootReader(req, d.rootToken ?? undefined)
  if (!root) return json(res, 403, { error: 'forbidden' })
  if (method === 'GET') {
    const doctor = doctorPath || new URL(req.url ?? '/', 'http://x').searchParams.get('doctor') === '1'
    return json(res, 200, doctor ? { checks: await runDoctor(await doctorDepsOf(d, model(d))) } : model(d))
  }
  if (method !== 'POST' && (doctorPath || method !== 'PUT')) return json(res, 405, { error: 'method_not_allowed' })
  const verdict = (d.guard ?? ((r: IncomingMessage) => settingsGuard(r)))(req)
  if (!verdict.ok) {
    await audit(d, req, { action: 'denied', via: 'rejected', detail: verdict.reason })
    return json(res, 403, { error: 'forbidden' })
  }
  return method === 'PUT' ? write(req, res, d, verdict.via) : fix(req, res, d, verdict.via)
}

/** `/api/control/effective` (or `/api/control/doctor` with `doctorPath`); settles after the response is written. */
export function controlEffectiveRoute(req: IncomingMessage, res: ServerResponse, method: string, deps: ControlDeps, doctorPath = false): Promise<void> {
  return handle(req, res, method, deps, doctorPath).catch((err: unknown) => {
    log.error('control.route_failed', 'Control route failed', { method, cause: err instanceof Error ? err.message : 'error' })
    if (!res.writableEnded) json(res, 500, { error: 'internal' })
  })
}
