// GET /api/claude-launch/effective -> what agents, Central and helpers start with (claudeLaunch.effective.ts).
// POST /api/claude-launch/test { profileId } | { central: true } -> staged probe of a SAVED profile
// (never a draft command: the server only runs what Settings stored). UI-only, like the provider
// test: an agent credential or a non-browser caller gets 403.
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { claudeChildEnv } from '../central/runtime/claudeOptions'
import { providerView } from '../claudeProvider/claudeProvider.store'
import { centralClaudeLaunch, effectiveLaunchTargets, resolveClaudeLaunch } from './claudeLauncher'
import { envProxyAuth } from '../agentEnv'
import { CLAUDE_LAUNCH_EFFECTIVE_PATH, type EffectiveClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.effective'
import type { ProviderView } from '../claudeProvider/claudeProvider.model'
import { probeClaudeLaunch, type LaunchProbe, type ProbeDeps } from './claudeLaunch.probe'

export const CLAUDE_LAUNCH_TEST_PATH = '/api/claude-launch/test'
const BODY_MAX_BYTES = 4 * 1024

export interface LaunchApiDeps {
  isNodeToken(token: string): boolean
  /** Drops Central's cached preflight so the dialog sees the new result. */
  refreshCentral(): void
  probe?: (launch: ReturnType<typeof resolveClaudeLaunch>, d: ProbeDeps) => Promise<LaunchProbe>
}

type Result = { status: number; body: unknown }

/** Where the next Claude's credential comes from (a server-env proxy or key counts only in login mode). */
export function credentialSource(mode: ProviderView['mode'], env: NodeJS.ProcessEnv): EffectiveClaudeLaunch['credential'] {
  if (mode === 'command') return 'command'
  if (mode !== 'login') return 'card'
  return envProxyAuth(env) || !!env.ANTHROPIC_API_KEY ? 'env' : 'login'
}

/** GET body of the effective-launch route. */
export const effectiveClaudeLaunch = (provider: Pick<ProviderView, 'mode'> = providerView(), env: NodeJS.ProcessEnv = claudeChildEnv(process.env)): EffectiveClaudeLaunch =>
  ({ ...effectiveLaunchTargets(), credential: credentialSource(provider.mode, env) })

/** Handles the routes; null = not one of these paths. */
export async function claudeLaunchRoute(req: IncomingMessage, url: URL, deps: LaunchApiDeps): Promise<Result | null> {
  if (url.pathname !== CLAUDE_LAUNCH_TEST_PATH && url.pathname !== CLAUDE_LAUNCH_EFFECTIVE_PATH) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_test_launch' : denial } }
  if (url.pathname === CLAUDE_LAUNCH_EFFECTIVE_PATH) return req.method === 'GET' ? { status: 200, body: effectiveClaudeLaunch() } : { status: 405, body: { error: 'method_not_allowed' } }
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
  if (!read.ok) return { status: read.reason === 'too_large' ? 413 : 400, body: { error: read.reason } }
  let body: unknown
  try { body = read.body === '' ? {} : JSON.parse(read.body) } catch { return { status: 400, body: { error: 'invalid_json' } } }
  const { profileId, central } = (body && typeof body === 'object' ? body : {}) as { profileId?: unknown; central?: unknown }
  if (central !== true && typeof profileId !== 'string') return { status: 400, body: { error: 'profile_required' } }
  const launch = central === true ? centralClaudeLaunch() : resolveClaudeLaunch(profileId as string)
  if (central !== true && launch.missingId) return { status: 404, body: { error: 'unknown_profile' } }
  if (central === true) deps.refreshCentral()
  // Central's env (claudeChildEnv: only the named provider vars), so a server-env proxy counts as signed in.
  const result = await (deps.probe ?? probeClaudeLaunch)(launch, { env: claudeChildEnv(process.env), provider: providerView() })
  return { status: 200, body: { ...result, warnings: launch.warnings } }
}
