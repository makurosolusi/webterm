// `/api/claude-provider` (Settings > Capabilities > Claude provider). UI-only, same gate as the
// secret broker (secret.api.ts): an agent credential or a non-browser caller gets 403.
//   GET  /api/claude-provider       config view (secret: set/unset only), last test, sessions to restart
//   PUT  /api/claude-provider       { mode, baseUrl?, credential?, model?, secret? }; never echoes secret
//   POST /api/claude-provider/test  probe the SAVED provider (login mode: `claude auth status`;
//                                   command mode: run the launch profile headless, claudeProvider.commandProbe.ts)
//   GET  /api/claude-provider/detect  { wrappers: [{ name, installed, version? }] } for the command-mode card
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { resolveClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import { claudeChildEnv } from '../central/runtime/claudeOptions'
import type { RunFn } from '../claudeLauncher/claudeLaunch.probe'
import { probeCommand } from './claudeProvider.commandProbe'
import { detectWrappers } from './claudeProvider.detect'
import { parseUpdate } from './claudeProvider.model'
import { probeProvider, type ProbeResult } from './claudeProvider.probe'
import { loadConfig, loadSecret, providerView, saveProvider } from './claudeProvider.store'

export const PROVIDER_PATH = '/api/claude-provider'
export const DETECT_PATH = `${PROVIDER_PATH}/detect`
const BODY_MAX_BYTES = 16 * 1024

export type LastTest = ProbeResult & { at: number }
let lastTest: LastTest | null = null
/** Last "Test connection" result of this process (Doctor reads it). */
export const lastProviderTest = (): LastTest | null => lastTest

export interface ProviderApiDeps {
  isNodeToken(token: string): boolean
  /** Live Claude sessions started before `t` (they keep the old provider until restarted). */
  sessionsBefore(t: number): number
  /** Login-mode test: Claude Code's own `auth status`. */
  loginReady(): Promise<{ ok: boolean; hint?: string }>
  fetch?: typeof fetch
  /** Command-mode process runner / PATH lookup / env (tests inject fakes; default: real spawn, Central's scrubbed env). */
  run?: RunFn
  onPath?: (name: string) => boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
}

type Result = { status: number; body: unknown }

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
    saveProvider(parsed.config, parsed.secret, undefined, now())
    lastTest = null // the old result described another provider
    return { status: 200, body: view(deps) }
  }
  if (url.pathname === DETECT_PATH && method === 'GET') {
    const wrappers = await detectWrappers({ env: deps.env ?? claudeChildEnv(process.env), ...(deps.run ? { run: deps.run } : {}), ...(deps.onPath ? { onPath: deps.onPath } : {}) })
    return { status: 200, body: { wrappers } }
  }
  if (url.pathname === `${PROVIDER_PATH}/test` && method === 'POST') {
    const c = loadConfig()
    let r: ProbeResult
    if (c.mode === 'login') {
      const ready = await deps.loginReady()
      r = ready.ok
        ? { outcome: 'ok', ok: true, message: 'Claude Code is installed and logged in.' }
        : { outcome: 'auth_rejected', ok: false, message: ready.hint ?? 'Claude Code is not logged in.' }
    } else if (c.mode === 'command') {
      r = await probeCommand(resolveClaudeLaunch(c.profileId), {
        env: deps.env ?? claudeChildEnv(process.env), ...(deps.run ? { run: deps.run } : {}), ...(deps.onPath ? { onPath: deps.onPath } : {}),
      })
    } else {
      r = await probeProvider(c, loadSecret(), deps.fetch)
    }
    lastTest = { ...r, at: now() }
    return { status: 200, body: { test: lastTest } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** Route entry for api.ts: false = not ours. */
export async function providerRoute(req: IncomingMessage, url: URL, deps: ProviderApiDeps): Promise<Result | null> {
  if (url.pathname !== PROVIDER_PATH && url.pathname !== `${PROVIDER_PATH}/test` && url.pathname !== DETECT_PATH) return null
  let raw = ''
  if (req.method === 'PUT' || req.method === 'POST') {
    const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
    if (!read.ok) return { status: read.reason === 'too_large' ? 413 : 400, body: { error: read.reason } }
    raw = read.body
  }
  return handleProviderApi(req, url, raw, deps)
}
