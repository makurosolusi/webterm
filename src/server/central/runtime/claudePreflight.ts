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
  return { ok: false, code: CODE[p.failed], hint, stage: step?.stage, failed: p.failed, profile: p.profile }
}

async function check(d: PreflightDeps): Promise<ClaudeReady> {
  const launch = d.executable ? bare(d.executable) : (d.launch ?? centralClaudeLaunch)()
  const provider = (d.provider ?? providerView)()
  return toClaudeReady(await probeClaudeLaunch(launch, {
    env: d.env, ...(d.run ? { run: d.run } : {}), ...(d.onPath ? { onPath: d.onPath } : {}),
    ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}), provider,
  }))
}

/** Builds the lazy preflight: concurrent calls share one probe and the result is cached for `ttlMs`. */
export function createClaudePreflight(d: PreflightDeps): () => Promise<ClaudeReady> {
  const now = d.now ?? Date.now
  const ttl = d.ttlMs ?? READY_TTL_MS
  let cached: { at: number; value: Promise<ClaudeReady> } | null = null
  return () => {
    if (cached && now() - cached.at < ttl) return cached.value
    const value = check(d)
    cached = { at: now(), value }
    return value
  }
}
