// `/api/claude-provider` (Settings > Claude > Connection). UI-only, same gate as the
// secret broker (secret.api.ts): an agent credential or a non-browser caller gets 403.
//   GET  /api/claude-provider       config view (secret: set/unset only), last test, sessions to restart
//   PUT  /api/claude-provider       { mode, baseUrl?, credential?, model?, secret? }; never echoes secret
//   POST /api/claude-provider/test  staged Test connection of the SAVED provider, NDJSON (claudeProvider.connectionStream.ts)
//   GET  /api/claude-provider/detect  { wrappers: [{ name, installed, version? }] } for the command-mode card
//   POST /api/claude-provider/reset back to the login; a damaged config is kept as CONFIG_BAK (view.configError)
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { claudeChildEnv } from '../central/runtime/claudeOptions'
import type { RunFn } from '../claudeLauncher/claudeLaunch.probe'
import { detectWrappers } from './claudeProvider.detect'
import { parseUpdate } from './claudeProvider.model'
import type { ConnStage } from './claudeProvider.connectionTest'
import { loadConfig, providerView, resetProviderConfig, saveProvider } from './claudeProvider.store'
import { defaultProfileAfter } from './claudeProvider.command'
import type { ProviderConfig } from './claudeProvider.model'

export const PROVIDER_PATH = '/api/claude-provider'
export const DETECT_PATH = `${PROVIDER_PATH}/detect`
export const RESET_PATH = `${PROVIDER_PATH}/reset`
const BODY_MAX_BYTES = 16 * 1024

/** A finished Test connection: `message` is its summary line, `stage` where it failed. */
export interface LastTest { ok: boolean; message: string; stage?: ConnStage; at: number }
let lastTest: LastTest | null = null
/** Last "Test connection" result of this process (Doctor reads it). */
export const lastProviderTest = (): LastTest | null => lastTest
/** Keeps a finished test (the stream calls it); GET returns it until the provider changes. */
export const rememberProviderTest = (t: Omit<LastTest, 'at'>, now: () => number = Date.now): void => { lastTest = { ...t, at: now() } }

export interface ProviderApiDeps {
  isNodeToken(token: string): boolean
  /** Live Claude sessions started before `t` (they keep the old provider until restarted). */
  sessionsBefore(t: number): number
  /** Wrapper detection's process runner / PATH lookup / env (tests inject fakes; default: real spawn, Central's scrubbed env). */
  run?: RunFn
  onPath?: (name: string) => boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** The settings default for new Claude agents; a command-mode save writes its profile there (`defaultProfileAfter`). */
  defaults?: { get(): string; set(profileId: string): void }
}

type Result = { status: number; body: unknown }

/** Keeps the settings default in step with command mode after a provider write. */
function syncDefault(deps: ProviderApiDeps, prev: ProviderConfig): void {
  if (!deps.defaults) return
  const id = defaultProfileAfter(prev, loadConfig(), deps.defaults.get())
  if (id !== null) deps.defaults.set(id)
}

function view(deps: ProviderApiDeps): Record<string, unknown> {
  const provider = providerView()
  return { provider, lastTest, restartNeeded: provider.updatedAt ? deps.sessionsBefore(provider.updatedAt) : 0 }
}

/** Handles the provider routes for an already-matched path; `raw` = request body text. */
export async function handleProviderApi(req: IncomingMessage, url: URL, raw: string, deps: ProviderApiDeps): Promise<Result> {
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_manage_provider' : denial } }
  const method = req.method ?? 'GET'
  const now = deps.now ?? Date.now
  if (url.pathname === PROVIDER_PATH && method === 'GET') return { status: 200, body: view(deps) }
  if (url.pathname === PROVIDER_PATH && method === 'PUT') {
    let body: unknown
    try { body = raw === '' ? {} : JSON.parse(raw) } catch { return { status: 400, body: { error: 'invalid_json' } } } // never echo: it holds the key
    const parsed = parseUpdate(body)
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
    const prev = loadConfig()
    saveProvider(parsed.config, parsed.secret, undefined, now())
    syncDefault(deps, prev)
    lastTest = null // the old result described another provider
    return { status: 200, body: view(deps) }
  }
  if (url.pathname === RESET_PATH && method === 'POST') {
    const prev = loadConfig()
    resetProviderConfig()
    syncDefault(deps, prev)
    lastTest = null
    return { status: 200, body: view(deps) }
  }
  if (url.pathname === DETECT_PATH && method === 'GET') {
    const wrappers = await detectWrappers({ env: deps.env ?? claudeChildEnv(process.env), ...(deps.run ? { run: deps.run } : {}), ...(deps.onPath ? { onPath: deps.onPath } : {}) })
    return { status: 200, body: { wrappers } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** Route entry for api.ts: false = not ours. */
export async function providerRoute(req: IncomingMessage, url: URL, deps: ProviderApiDeps): Promise<Result | null> {
  if (url.pathname !== PROVIDER_PATH && url.pathname !== DETECT_PATH && url.pathname !== RESET_PATH) return null
  let raw = ''
  if (req.method === 'PUT' || req.method === 'POST') {
    const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
    if (!read.ok) return { status: read.reason === 'too_large' ? 413 : 400, body: { error: read.reason } }
    raw = read.body
  }
  return handleProviderApi(req, url, raw, deps)
}
