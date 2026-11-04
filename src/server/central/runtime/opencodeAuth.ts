// Credential bridge + readiness probe for the OpenCode adapter.
//
// WHY: the child runs with an isolated HOME/XDG (`<dataDir>/central/home`) so the user's opencode
// config and plugins are never loaded. But then it has no provider credentials and every turn ends in
// `provider.no-route`. opencode v2 keeps credentials in its sqlite store, not in `auth.json` (copying
// auth.json into a fresh HOME was verified to change nothing on v2.0.26), so we move ONLY the
// credentials of the configured model's provider with opencode's own `auth export` -> `auth import`.
// The export travels through memory (stdin of the import); it is never written to disk or logged.
// `--standalone` everywhere: without it opencode attaches to (or tries to start) the user's managed
// background service, which collides with a running `opencode serve --service`.
import { spawn } from 'node:child_process'
import { opencodeHomeEnv, scrubOpencodeEnv } from './opencodeOptions'
import { prepareOpencodeHome } from './opencodeSession'

export type OpencodeIssue = 'opencode_not_found' | 'opencode_model_unavailable' | 'opencode_check_failed'
export type OpencodeReady = { ok: true } | { ok: false; code: OpencodeIssue; reason: string }

export interface OcRunResult { code: number | null; stdout: string; timedOut: boolean }
/** Runs one opencode command (argv, no shell); `input` is piped to stdin. Rejects with `.code` on spawn failure. */
export type OcRunFn = (
  exe: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number }
) => Promise<OcRunResult>

export interface OpencodePreflightDeps {
  executable: string
  model: string
  homeDir: string
  /** The user's environment (real HOME/XDG): the export source. Scrubbed before use. */
  env: NodeJS.ProcessEnv
  cwd?: string
  run?: OcRunFn
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

export const OPENCODE_READY_TTL_MS = 5 * 60_000
export const OPENCODE_UNREADY_TTL_MS = 30_000
export const OPENCODE_CHECK_TIMEOUT_MS = 20_000
const MAX_STDOUT = 1024 * 1024

/** Default runner: no shell, stdout capped in memory, stderr discarded (may echo credentials). */
export const runOpencode: OcRunFn = (exe, args, { env, cwd, input, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env, cwd, shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    })
    let stdout = ''
    let timedOut = false
    let stdinFailed = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < MAX_STDOUT) stdout += chunk })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`spawn opencode failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`), {
        code: (err as NodeJS.ErrnoException).code,
      }))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: stdinFailed && code === 0 ? 1 : code, stdout, timedOut })
    })
    if (input !== undefined && child.stdin) {
      // EPIPE when the child exits before reading stdin: reported as a failed run, never thrown.
      child.stdin.on('error', () => { stdinFailed = true })
      child.stdin.end(input)
    }
  })

/** Provider id of `provider/model#variant`. */
export function providerOf(model: string): string {
  return model.split('/')[0]?.trim() ?? ''
}

/** True when `auth list --format json` shows at least one connection for `provider`. */
export function hasProviderCredential(listJson: string, provider: string): boolean {
  try {
    const parsed: unknown = JSON.parse(listJson)
    if (!Array.isArray(parsed)) return false
    return parsed.some((entry) => {
      const e = entry as { id?: unknown; connections?: unknown }
      return e.id === provider && Array.isArray(e.connections) && e.connections.length > 0
    })
  } catch {
    // Unparseable list output means "cannot confirm a credential": the caller reports not-ready.
    return false
  }
}

function notReady(code: OpencodeIssue, reason: string): OpencodeReady {
  return { ok: false, code, reason }
}

async function check(d: OpencodePreflightDeps): Promise<OpencodeReady> {
  const run = d.run ?? runOpencode
  const timeoutMs = d.timeoutMs ?? OPENCODE_CHECK_TIMEOUT_MS
  const provider = providerOf(d.model)
  if (provider === '') return notReady('opencode_model_unavailable', `model "${d.model}" has no provider prefix`)
  const sourceEnv = scrubOpencodeEnv(d.env)
  const isolatedEnv = { ...sourceEnv, ...opencodeHomeEnv(d.homeDir) }
  try {
    prepareOpencodeHome(d.homeDir)
    const exported = await run(d.executable, ['auth', 'export', '--standalone', provider], { env: sourceEnv, cwd: d.cwd, timeoutMs })
    // A failed export (user not logged in to this provider) is not fatal: an earlier import may still hold.
    if (exported.code === 0 && !exported.timedOut && exported.stdout.trim().startsWith('[')) {
      await run(d.executable, ['auth', 'import', '--standalone'], { env: isolatedEnv, cwd: d.cwd, input: exported.stdout, timeoutMs })
    }
    const listed = await run(d.executable, ['auth', 'list', '--standalone', '--format', 'json'], { env: isolatedEnv, cwd: d.cwd, timeoutMs })
    if (listed.timedOut || listed.code !== 0) {
      return notReady('opencode_check_failed', `opencode auth list failed (exit ${listed.timedOut ? 'timeout' : String(listed.code)})`)
    }
    return hasProviderCredential(listed.stdout, provider)
      ? { ok: true }
      : notReady('opencode_model_unavailable',
        `model "${d.model}" unavailable: no "${provider}" credential for the central opencode home; run "opencode auth login" as the server user`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return notReady('opencode_not_found', `opencode executable "${d.executable}" not found`)
    }
    return notReady('opencode_check_failed', `opencode readiness check failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

/** Lazy, cached probe: concurrent calls share one check; ready is kept 5 min, not-ready 30 s. */
export function createOpencodePreflight(d: OpencodePreflightDeps): () => Promise<OpencodeReady> {
  const now = d.now ?? Date.now
  let cached: { at: number; ttl: number; value: Promise<OpencodeReady> } | null = null
  return () => {
    if (cached && now() - cached.at < cached.ttl) return cached.value
    const entry = { at: now(), ttl: d.ttlMs ?? OPENCODE_UNREADY_TTL_MS, value: check(d) }
    void entry.value.then((ready) => { if (ready.ok) entry.ttl = d.ttlMs ?? OPENCODE_READY_TTL_MS })
    cached = entry
    return entry.value
  }
}

const shared = new Map<string, () => Promise<OpencodeReady>>()
const sharedKey = (d: OpencodePreflightDeps) => `${d.executable}\0${d.model}\0${d.homeDir}`

/** Process-wide probe per (executable, model, home), so health and turns share one cache. */
export function sharedOpencodePreflight(d: OpencodePreflightDeps): () => Promise<OpencodeReady> {
  const key = sharedKey(d)
  let probe = shared.get(key)
  if (!probe) {
    probe = createOpencodePreflight(d)
    shared.set(key, probe)
  }
  return probe
}

/** Explicit re-check: drop the shared cached probe so this call runs a new one, which later calls then reuse. */
export function freshSharedOpencodePreflight(d: OpencodePreflightDeps): Promise<OpencodeReady> {
  shared.delete(sharedKey(d))
  return sharedOpencodePreflight(d)()
}
