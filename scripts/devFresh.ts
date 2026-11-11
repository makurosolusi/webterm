// `bun run dev:fresh`: a second webterm that behaves like the first run on a machine that never had
// webterm (like VS Code / Chrome `--user-data-dir`), side by side with the real one. Everything it
// writes lives in one temp root; ports, the tmux socket and the Vite cache are its own, so it never
// sees or adopts the real instance's sessions. Ctrl+C stops it and deletes the root.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'

/** First port tried when `--port` is absent; well clear of the real instance's 8700/8701. */
export const FRESH_DEFAULT_PORT = 8710
/** Ports of the real dev instance (main + proxy): never handed to the fresh one. */
export const RESERVED_PORTS: readonly number[] = [8700, 8701]
/** Temp root basename prefix; cleanup refuses any directory without it. */
export const ROOT_PREFIX = 'webterm-fresh-'
const LOOPBACK = '127.0.0.1'
const PORT_PROBE_SPAN = 100
const STOP_GRACE_MS = 5000
const REPO_ROOT = resolve(import.meta.dirname, '..')
/** Prefixes/keys that would carry the real install into the child. */
const STRIP_PREFIXES = ['WEBTERM_', 'NODETERM_', 'XDG_']
const STRIP_KEYS = ['TMUX', 'TMUX_PANE', 'NODE_ENV', 'HOST', 'PORT', 'ZDOTDIR', 'CLAUDECODE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']
/** Provider credentials/config: a new machine has none, so dropped unless `--with-provider-env`. */
const PROVIDER_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_']

export interface FreshOptions { port?: number; keep: boolean; noClaude: boolean; withProviderEnv: boolean }
export interface FreshPaths { root: string; data: string; home: string; claude: string; vite: string }

/** Parse CLI flags; unknown flags and bad ports throw instead of being ignored. */
export function parseFreshArgs(argv: readonly string[]): FreshOptions {
  const o: FreshOptions = { keep: false, noClaude: false, withProviderEnv: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') o.keep = true
    else if (a === '--no-claude') o.noClaude = true
    else if (a === '--with-provider-env') o.withProviderEnv = true
    else if (a === '--port') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port needs a port 1-65535, got "${argv[i] ?? ''}"`)
      o.port = n
    } else throw new Error(`unknown flag "${a}" (use --port <n>, --keep, --no-claude, --with-provider-env)`)
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

/** Child env: the caller's env minus anything of the real install, plus the fresh dirs and ports. Pure. */
export function buildFreshEnv(
  base: NodeJS.ProcessEnv,
  i: { paths: FreshPaths; port: number; proxyPort: number; noClaude: boolean; withProviderEnv: boolean; has?: (dir: string, bin: string) => boolean },
): Record<string, string> {
  const drop = (k: string) => STRIP_KEYS.includes(k) || STRIP_PREFIXES.some((p) => k.startsWith(p))
    || (!i.withProviderEnv && PROVIDER_PREFIXES.some((p) => k.startsWith(p)))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop(k)) env[k] = v
  Object.assign(env, {
    WEBTERM_DATA_DIR: i.paths.data, HOME: i.paths.home, CLAUDE_CONFIG_DIR: i.paths.claude,
    PORT: String(i.port), WEBTERM_PROXY_PORT: String(i.proxyPort), WEBTERM_VITE_CACHE_DIR: i.paths.vite,
  })
  if (i.noClaude) env.PATH = pathWithout(env.PATH ?? '', 'claude', i.has)
  return env
}

/** Throw unless `root` is a `webterm-fresh-*` dir directly inside `tmpBase` (both resolved through symlinks). */
export function assertFreshRoot(root: string, tmpBase: string = tmpdir()): void {
  const base = realpathSync(tmpBase)
  const dir = resolve(root)
  const real = join(realpathSync(dirname(dir)), basename(dir))
  if (dirname(real) !== base || !basename(real).startsWith(ROOT_PREFIX)) {
    throw new Error(`refusing to delete ${root}: not a ${ROOT_PREFIX}* directory directly inside ${base}`)
  }
}

/** Delete a temp root created by `makeFreshRoot`; anything else throws. */
export function removeFreshRoot(root: string, tmpBase: string = tmpdir()): void {
  assertFreshRoot(root, tmpBase)
  rmSync(root, { recursive: true, force: true })
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
  const env = buildFreshEnv(process.env, { paths, port, proxyPort, noClaude: o.noClaude, withProviderEnv: o.withProviderEnv })
  // Bun auto-loads a cwd `.env` (the real install's provider keys); a fresh machine has none.
  const args = [...(o.withProviderEnv ? [] : ['--no-env-file']), 'src/server/index.ts']
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio, detached: true }) // own group: stop() kills shells too
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  let stopped: Promise<void> | undefined
  const stop = () => (stopped ??= (async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      signalGroup(child.pid, 'SIGTERM')
      const t = setTimeout(() => signalGroup(child.pid!, 'SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(t)
    }
    killTmuxServer(env, paths.data)
    if (!o.keep) removeFreshRoot(paths.root)
  })())
  return { paths, port, url: `http://${LOOPBACK}:${port}`, env, child, stop }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`cannot send ${sig} to process group ${pid}`, { cause: e })
  }
}

/** The fresh tmux server (socket derived from ITS data dir, never `webterm`) outlives the child by design; end it. */
function killTmuxServer(env: Record<string, string>, dataDir: string): void {
  const tmux = findOnPath('tmux', env.PATH) ?? findOnPath('tmux')
  if (!tmux) return
  const r = spawnSync(tmux, ['-L', supervisorSocket(dataDir), 'kill-server'], { env, stdio: 'ignore' })
  if (r.error) process.stderr.write(`dev:fresh: tmux kill-server failed (${r.error.message})\n`)
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

async function main(): Promise<void> {
  const o = parseFreshArgs(process.argv.slice(2))
  const fresh = await startFresh(o)
  const shutdown = (code: number) => {
    fresh.stop().then(() => process.exit(code), (e: unknown) => { process.stderr.write(`dev:fresh: cleanup failed: ${String(e)}\n`); process.exit(1) })
  }
  process.on('SIGINT', () => shutdown(130)).on('SIGTERM', () => shutdown(143))
  fresh.child.once('exit', (code) => shutdown(code ?? 1))
  try { await waitForHttp(`${fresh.url}/api/health`, 60_000, fresh.child) } catch (e) { await fresh.stop(); throw e }
  const claudeNote = o.noClaude ? ` (claude still on PATH: ${findOnPath('claude', fresh.env.PATH) ? 'YES' : 'no'})` : ''
  process.stdout.write([
    '', `  webterm FRESH instance  ->  ${fresh.url}`,
    '  Isolated first-run install: own data dir, HOME, Claude config, ports and tmux socket.',
    `  Temp root:  ${fresh.paths.root}`,
    `  Token file: ${join(fresh.paths.data, 'secrets', 'WEBTERM_TOKEN')}`,
    `  Flags: ${o.noClaude ? 'no-claude' + claudeNote : 'claude on PATH'}, ${o.withProviderEnv ? 'provider env + .env kept' : 'no provider env, no .env'}`,
    o.keep ? '  Ctrl+C to stop (temp root is KEPT).' : '  Ctrl+C to stop and delete.', '',
  ].join('\n') + '\n')
}

if (import.meta.main) main().catch((e: unknown) => { process.stderr.write(`dev:fresh failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1) })
