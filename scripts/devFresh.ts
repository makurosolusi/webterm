// `bun run dev:fresh`: a second webterm that behaves like your own first `bun run dev` on THIS machine
// (like VS Code / Chrome `--user-data-dir`), side by side with the real one. Only webterm's own state is
// fresh (data dir, ports, tmux socket, Vite cache); HOME, the Claude login, `.env` and your tools are
// the real ones. `--empty-home` / `--no-claude` simulate a different machine instead. Everything it
// writes lives in one temp root, so it never sees or adopts the real instance's sessions. Ctrl+C stops it and deletes the root; a run that died
// any other way is cleaned by the next start (devFresh.sweep.ts) or by its own server's watchdog.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'
import { ROOT_ARG, ROOT_PREFIX, deleteClaudeKeychain, killTmuxServer, removeFreshRoot, sweepStale, writeOwner, type SweepResult } from './devFresh.sweep'

export { ROOT_PREFIX, assertFreshRoot, removeFreshRoot } from './devFresh.sweep'

/** First port tried when `--port` is absent; well clear of the real instance's 8700/8701. */
export const FRESH_DEFAULT_PORT = 8710
/** Env var naming this script's pid for the server's watchdog (literal repeated in devFresh.watchdog.ts). */
export const PARENT_ENV = 'WEBTERM_FRESH_PARENT_PID'
/** cli.launcher.ts `SKIP_HOME_INSTALLS_ENV` (not imported: its module chain loads the server config). */
export const SKIP_HOME_INSTALLS_ENV = 'WEBTERM_SKIP_HOME_INSTALLS'
/** Ports of the real dev instance (main + proxy): never handed to the fresh one. */
export const RESERVED_PORTS: readonly number[] = [8700, 8701]
const LOOPBACK = '127.0.0.1'
const PORT_PROBE_SPAN = 100
const STOP_GRACE_MS = 5000
const REPO_ROOT = resolve(import.meta.dirname, '..')
/** Prefixes/keys that would point the child at the real webterm instance (or mark it as running inside one). */
// legacy: NODETERM_ = pre-rename prefix, still stripped; remove after 0.10.0.
const STRIP_PREFIXES = ['WEBTERM_', 'NODETERM_']
const STRIP_KEYS = ['TMUX', 'TMUX_PANE', 'NODE_ENV', 'HOST', 'PORT', 'CLAUDECODE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']
/** `--empty-home` only: a brand-new OS user has no provider env, XDG dirs or zsh dotdir. */
const EMPTY_HOME_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'XDG_']
const EMPTY_HOME_KEYS = ['ZDOTDIR', 'CLAUDE_CONFIG_DIR']
/** Every scenario flag, for the banner: nothing to remember. */
export const SCENARIO_FLAGS = '--empty-home (brand-new OS user: temp HOME + Claude config, no .env), --no-claude (claude not installed), --keep, --port <n>, --clean'

export interface FreshOptions { port?: number; keep: boolean; noClaude: boolean; emptyHome: boolean; clean: boolean }
export interface FreshPaths { root: string; data: string; home: string; claude: string; vite: string }

/** Parse CLI flags; unknown flags and bad ports throw instead of being ignored. */
export function parseFreshArgs(argv: readonly string[]): FreshOptions {
  const o: FreshOptions = { keep: false, noClaude: false, emptyHome: false, clean: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') o.keep = true
    else if (a === '--no-claude') o.noClaude = true
    else if (a === '--empty-home') o.emptyHome = true
    else if (a === '--clean') o.clean = true
    else if (a === '--port') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port needs a port 1-65535, got "${argv[i] ?? ''}"`)
      o.port = n
    } else throw new Error(`unknown flag "${a}" (use --port <n>, --keep, --no-claude, --empty-home, --clean)`)
  }
  return o
}

/** Layout of a temp root. */
export function freshPaths(root: string): FreshPaths {
  return { root, data: join(root, 'data'), home: join(root, 'home'), claude: join(root, 'claude'), vite: join(root, 'vite') }
}

/** PATH without every directory that holds an executable `bin`. */
export function pathWithout(pathEnv: string, bin: string, has: (dir: string, bin: string) => boolean = (dir, b) => findOnPath(b, dir) !== undefined): string {
  return pathEnv.split(delimiter).filter((d) => d !== '' && !has(d, bin)).join(delimiter)
}

/**
 * Child env, pure. `base` = the caller's env (plus `.env`, see withDotenv) minus anything that points at
 * the real webterm instance, plus the fresh data dir, ports and Vite cache. Default: HOME, CLAUDE_CONFIG_DIR,
 * provider vars and XDG dirs stay the caller's, and the home installs (~/.claude/skills, which embed this
 * instance's data-dir paths) are skipped. `emptyHome`: temp HOME + CLAUDE_CONFIG_DIR, no provider env.
 */
export function buildFreshEnv(
  base: NodeJS.ProcessEnv,
  i: { paths: FreshPaths; port: number; proxyPort: number; noClaude: boolean; emptyHome: boolean; has?: (dir: string, bin: string) => boolean },
): Record<string, string> {
  const drop = (k: string) => STRIP_KEYS.includes(k) || STRIP_PREFIXES.some((p) => k.startsWith(p))
    || (i.emptyHome && (EMPTY_HOME_KEYS.includes(k) || EMPTY_HOME_PREFIXES.some((p) => k.startsWith(p))))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop(k)) env[k] = v
  Object.assign(env, {
    WEBTERM_DATA_DIR: i.paths.data, PORT: String(i.port), WEBTERM_PROXY_PORT: String(i.proxyPort), WEBTERM_VITE_CACHE_DIR: i.paths.vite,
  }, i.emptyHome ? { HOME: i.paths.home, CLAUDE_CONFIG_DIR: i.paths.claude } : { [SKIP_HOME_INSTALLS_ENV]: '1' })
  if (i.noClaude) env.PATH = pathWithout(env.PATH ?? '', 'claude', i.has)
  return env
}

/**
 * `base` plus the `.env` files Bun would load in `cwd` for `bun run dev`, resolved by Bun itself (same
 * files, order, `${VAR}` expansion; the caller's env wins). The values are piped back, never printed;
 * buildFreshEnv then strips WEBTERM_ and friends from the result, so a `.env` WEBTERM_DATA_DIR or PORT
 * cannot point the fresh instance at real data. The server then runs with `--no-env-file`.
 */
export function withDotenv(base: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'NODE_ENV')) // like `bun run dev`
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`reading .env in ${cwd} failed (bun exited ${r.status ?? r.signal})`) // stderr not shown: it may echo values
  return JSON.parse(r.stdout) as NodeJS.ProcessEnv
}

/** Create `<tmp>/webterm-fresh-<timestamp>-XXXXXX` with data/home/claude subdirs. */
export function makeFreshRoot(tmpBase: string = tmpdir()): FreshPaths {
  const p = freshPaths(mkdtempSync(join(realpathSync(tmpBase), `${ROOT_PREFIX}${Date.now()}-`)))
  for (const d of [p.data, p.home, p.claude]) mkdirSync(d, { recursive: true, mode: 0o700 })
  return p
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer().once('error', () => done(false)).once('listening', () => s.close(() => done(true)))
    s.listen(port, LOOPBACK)
  })
}

/** First free loopback port from `start`, skipping RESERVED_PORTS and `avoid`. */
export async function findFreePort(start: number, avoid: readonly number[] = []): Promise<number> {
  for (let p = start; p < start + PORT_PROBE_SPAN && p <= 65535; p++) {
    if (!RESERVED_PORTS.includes(p) && !avoid.includes(p) && (await portFree(p))) return p
  }
  throw new Error(`no free port in ${start}-${start + PORT_PROBE_SPAN - 1}`)
}

export interface FreshInstance { paths: FreshPaths; port: number; url: string; env: Record<string, string>; child: ChildProcess; stop(): Promise<void> }

/** Boot the fresh server. `stdio: 'pipe'` for tests (no TTY = no auto-opened browser window). */
export async function startFresh(o: FreshOptions, stdio: 'inherit' | 'pipe' = 'inherit'): Promise<FreshInstance> {
  if (o.port !== undefined && (RESERVED_PORTS.includes(o.port) || !(await portFree(o.port)))) throw new Error(`port ${o.port} is reserved or busy`)
  const port = o.port ?? (await findFreePort(FRESH_DEFAULT_PORT))
  const proxyPort = await findFreePort(port + 1, [port])
  const paths = makeFreshRoot()
  const env = buildFreshEnv(o.emptyHome ? process.env : withDotenv(process.env), { paths, port, proxyPort, noClaude: o.noClaude, emptyHome: o.emptyHome })
  // `.env` is already in `env` (default) or deliberately absent (--empty-home): Bun must not load it again unfiltered.
  // The watchdog stops the server when this script dies; ROOT_ARG lets the sweep prove the process is ours.
  const args = ['--no-env-file', '--preload', join(import.meta.dirname, 'devFresh.watchdog.ts'),
    'src/server/index.ts', `${ROOT_ARG}${paths.root}`]
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: { ...env, [PARENT_ENV]: String(process.pid) }, stdio, detached: true }) // own group: stop() kills shells too
  if (child.pid) {
    writeOwner(paths.root, {
      pid: process.pid, childPid: child.pid, pgid: child.pid, tmuxSocket: supervisorSocket(paths.data),
      claudeConfigDir: o.emptyHome ? paths.claude : '', createdAt: new Date().toISOString(), keep: o.keep,
    })
  }
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  let stopped: Promise<void> | undefined
  const stop = () => (stopped ??= (async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      signalGroup(child.pid, 'SIGTERM')
      const t = setTimeout(() => signalGroup(child.pid!, 'SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(t)
    }
    killTmuxServer(paths.data, env.PATH)
    if (o.emptyHome) deleteClaudeKeychain(paths.claude) // default mode uses the real login: never touched
    if (!o.keep) removeFreshRoot(paths.root)
  })())
  return { paths, port, url: `http://${LOOPBACK}:${port}`, env, child, stop }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`cannot send ${sig} to process group ${pid}`, { cause: e })
  }
}

/** Resolve once `url` answers any HTTP status (the server is listening). */
export async function waitForHttp(url: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error(`fresh server exited with code ${child.exitCode} before listening on ${url}`)
    try { await fetch(url); return } catch { await new Promise((r) => setTimeout(r, 200)) } // connection refused = not up yet; retried
  }
  throw new Error(`fresh server did not answer on ${url} within ${timeoutMs} ms`)
}

/** Lines `--clean` prints: what was removed, and live instances it left alone. */
export function cleanReport(r: SweepResult): string[] {
  return [
    `cleaned ${r.cleaned.length} stale fresh instance(s)`,
    ...r.kept.map((x) => `  stopped, files kept (--keep; delete by hand): ${x}`),
    ...r.failed.map((x) => `  could not clean: ${x}`),
    ...r.live.map((l) => `  live, left running: ${l.root} (dev:fresh pid ${l.pid})`),
  ]
}

async function main(): Promise<void> {
  const o = parseFreshArgs(process.argv.slice(2))
  if (o.clean) {
    process.stdout.write(cleanReport(await sweepStale()).join('\n') + '\n')
    return
  }
  const swept = await sweepStale()
  if (swept.cleaned.length) process.stdout.write(`dev:fresh: cleaned ${swept.cleaned.length} stale fresh instance(s)\n`)
  const fresh = await startFresh(o)
  const shutdown = (code: number) => {
    fresh.stop().then(() => process.exit(code), (e: unknown) => { process.stderr.write(`dev:fresh: cleanup failed: ${String(e)}\n`); process.exit(1) })
  }
  // SIGHUP = the terminal window was closed.
  process.on('SIGINT', () => shutdown(130)).on('SIGTERM', () => shutdown(143)).on('SIGHUP', () => shutdown(129))
  fresh.child.once('exit', (code) => shutdown(code ?? 1))
  try { await waitForHttp(`${fresh.url}/api/health`, 60_000, fresh.child) } catch (e) { await fresh.stop(); throw e }
  const claudeNote = o.noClaude ? ` (claude still on PATH: ${findOnPath('claude', fresh.env.PATH) ? 'YES' : 'no'})` : ''
  process.stdout.write([
    '', `  webterm FRESH instance  ->  ${fresh.url}`,
    o.emptyHome ? '  Brand-new OS user: own data dir, HOME, Claude config, ports and tmux socket; no .env.'
      : '  First webterm run on this machine: own data dir, ports, tmux socket. Your HOME, tools, Claude login and .env are real.',
    `  Temp root:  ${fresh.paths.root}`,
    '  No account yet: open the URL above to create one.',
    `  Active: ${o.noClaude ? 'no-claude' + claudeNote : 'claude on PATH'}, ${o.emptyHome ? 'empty HOME' : 'real HOME'}`,
    `  Scenario flags: ${SCENARIO_FLAGS}`,
    o.keep ? '  Ctrl+C to stop (temp root is KEPT).' : '  Ctrl+C to stop and delete.',
    '  Leftovers of crashed runs are removed at the next start; `bun run dev:fresh -- --clean` removes them now.', '',
  ].join('\n') + '\n')
}

if (import.meta.main) main().catch((e: unknown) => { process.stderr.write(`dev:fresh failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1) })
