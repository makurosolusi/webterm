// Cached readiness probe for Central's Claude: runs through the Central launch profile
// (server/claudeLauncher), so a wrapper such as `envman -e p:e -- claude` that injects the
// credential is part of the check. Stages and their redaction live in claudeLaunch.probe.ts.
import { providerView } from '../../claudeProvider/claudeProvider.store'
import type { ProviderView } from '../../claudeProvider/claudeProvider.model'
import { centralClaudeLaunch, DEFAULT_CLAUDE_PROFILE, type ResolvedClaudeLaunch } from '../../claudeLauncher/claudeLauncher'
import {
  AUTH_CHECK_TIMEOUT_MS, probeClaudeLaunch, spawnRun,
  type LaunchFailure, type LaunchProbe, type LaunchStage, type RunFn, type RunResult,
} from '../../claudeLauncher/claudeLaunch.probe'

export { AUTH_CHECK_TIMEOUT_MS, spawnRun, type RunFn, type RunResult }

export type ClaudeReady =
  | { ok: true }
  | {
    ok: false; code: 'claude_not_found' | 'claude_not_authenticated' | 'claude_check_failed'; hint: string
    /** Which stage failed and for which profile (the UI names both). */
    stage?: LaunchStage; failed?: LaunchFailure; profile?: LaunchProbe['profile']
    /** The failing stage was killed at its timeout; how long the whole probe took. */
    timedOut?: boolean; elapsedMs?: number
  }

export interface PreflightDeps {
  env: NodeJS.ProcessEnv
  /** Bare binary override (tests); otherwise the Central launch profile. */
  executable?: string
  launch?: () => ResolvedClaudeLaunch
  run?: RunFn
  onPath?: (name: string) => boolean
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
  /** Claude provider (Settings > Capabilities); defaults to the saved one. */
  provider?: () => Pick<ProviderView, 'mode' | 'ready'>
}

export const READY_TTL_MS = 30_000

const CODE: Record<LaunchFailure, Exclude<ClaudeReady, { ok: true }>['code']> = {
  wrapper_not_found: 'claude_check_failed',
  wrapper_failed: 'claude_check_failed',
  wrapper_signed_out: 'claude_check_failed',
  claude_not_found: 'claude_not_found',
  auth_failed: 'claude_not_authenticated',
  check_failed: 'claude_check_failed',
}

const bare = (exe: string): ResolvedClaudeLaunch => ({ argv: [exe], profile: DEFAULT_CLAUDE_PROFILE, wrapper: [], bin: exe, flags: [], warnings: [] })

/** Probe result -> the ClaudeReady every Central consumer already understands. */
export function toClaudeReady(p: LaunchProbe): ClaudeReady {
  if (p.ok || !p.failed) return { ok: true }
  const step = p.steps[p.steps.length - 1]
  const sentence = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`)
  const hint = step ? [step.message, step.hint].filter((t): t is string => !!t).map(sentence).join(' ') : ''
  return { ok: false, code: CODE[p.failed], hint, stage: step?.stage, failed: p.failed, profile: p.profile, timedOut: step?.timedOut === true }
}

/** Failures that say the profile itself cannot work. Anything else (a timeout, an unexpected exit, an
 *  unreadable status) is inconclusive: the turn runs and its own error, if any, is the answer. */
const DEFINITE: ReadonlySet<LaunchFailure> = new Set(['wrapper_not_found', 'wrapper_signed_out', 'claude_not_found', 'auth_failed'])

/** True when a not-ready result must stop a Central turn before Claude is started. */
export function blocksTurn(r: ClaudeReady): boolean {
  if (r.ok) return false
  return r.failed ? DEFINITE.has(r.failed) : r.code !== 'claude_check_failed'
}

/** The user-facing sentence of a blocked turn: profile plus the probe's own (redacted) stage message. */
export function unreadyMessage(r: ClaudeReady): string | undefined {
  if (r.ok || !r.hint) return undefined
  return `Claude Code is not ready${r.profile ? ` for launch profile "${r.profile.name}"` : ''}: ${r.hint}`
}

/** Log fields of a not-ready result: no CLI output beyond the probe's redacted message. */
export function preflightLogFields(r: ClaudeReady): Record<string, unknown> {
  if (r.ok) return { ok: true }
  return {
    code: r.code, stage: r.stage ?? null, failed: r.failed ?? null, profileId: r.profile?.id ?? null,
    elapsedMs: r.elapsedMs ?? null, timedOut: r.timedOut ?? false, reason: r.hint || null,
  }
}

async function check(d: PreflightDeps, now: () => number): Promise<ClaudeReady> {
  const started = now()
  const launch = d.executable ? bare(d.executable) : (d.launch ?? centralClaudeLaunch)()
  const provider = (d.provider ?? providerView)()
  const r = toClaudeReady(await probeClaudeLaunch(launch, {
    env: d.env, ...(d.run ? { run: d.run } : {}), ...(d.onPath ? { onPath: d.onPath } : {}),
    ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}), provider,
  }))
  return r.ok ? r : { ...r, elapsedMs: now() - started }
}

/** Builds the lazy preflight: concurrent calls share one probe; only a success is cached (for `ttlMs`),
 *  so the next turn or a Retry after a failure always probes again. */
export function createClaudePreflight(d: PreflightDeps): () => Promise<ClaudeReady> {
  const now = d.now ?? Date.now
  const ttl = d.ttlMs ?? READY_TTL_MS
  let cached: { at: number; value: Promise<ClaudeReady> } | null = null
  return () => {
    if (cached && now() - cached.at < ttl) return cached.value
    const entry = { at: now(), value: check(d, now) }
    cached = entry
    // A failure (or a throw) is only shared while in flight.
    const drop = (): void => { if (cached === entry) cached = null }
    entry.value.then((r) => { if (!r.ok) drop() }, drop)
    return entry.value
  }
}
