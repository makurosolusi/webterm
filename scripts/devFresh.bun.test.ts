import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'
import { fakeSecurity } from './devFresh.testutil'
import {
  RESERVED_PORTS, SKIP_HOME_INSTALLS_ENV, assertFreshRoot, buildFreshEnv, findFreePort, freshPaths, freshSetupCodePath, makeFreshRoot, parseFreshArgs,
  pathWithout, removeFreshRoot, startFresh, waitForHttp, withDotenv,
} from './devFresh'
import { SKIP_HOME_INSTALLS_ENV as SERVER_SKIP_ENV } from '../src/server/cli/cli.launcher'

const paths = freshPaths('/tmp/st/webterm-fresh-1-abc') // test-only
// test-only: a real-looking install leaking through the parent env.
const realEnv: NodeJS.ProcessEnv = {
  PATH: '/a:/b', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', HOME: '/Users/me', NODE_ENV: 'test',
  WEBTERM_DATA_DIR: '/Users/me/.webterm-server', WEBTERM_TOKEN: 'x', NODETERM_PORT: '8700', TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%1',
  ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/Users/me/.claude',
  CLAUDECODE: '1', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/me/.claude', ZDOTDIR: '/Users/me', XDG_CONFIG_HOME: '/Users/me/.config', PORT: '8700',
}
/** Message of what `fn` throws ('' when it does not throw). */
const thrown = (fn: () => unknown): string => { try { fn(); return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }
const build = (o: { emptyHome?: boolean; noClaude?: boolean } = {}) =>
  buildFreshEnv(realEnv, { paths, port: 8710, proxyPort: 8711, noClaude: !!o.noClaude, emptyHome: !!o.emptyHome, has: (d) => d === '/b' })
const STRIPPED = ['WEBTERM_DATA_DIR', 'WEBTERM_TOKEN', 'NODETERM_PORT', 'TMUX', 'TMUX_PANE', 'NODE_ENV', 'PORT', 'CLAUDECODE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']
const OWNED = { WEBTERM_DATA_DIR: paths.data, PORT: '8710', WEBTERM_PROXY_PORT: '8711', WEBTERM_VITE_CACHE_DIR: paths.vite }

test('env (default): the parent env exactly, minus what points at the real webterm, plus the fresh data dir/ports/cache', () => {
  const expected: Record<string, string> = {}
  for (const [k, v] of Object.entries(realEnv)) if (!STRIPPED.includes(k)) expected[k] = v as string
  // HOME, CLAUDE_CONFIG_DIR, provider vars, XDG and ZDOTDIR are the user's own; home installs are skipped.
  expect(build()).toEqual({ ...expected, ...OWNED, [SKIP_HOME_INSTALLS_ENV]: '1' })
  expect(SKIP_HOME_INSTALLS_ENV).toBe(SERVER_SKIP_ENV)
})

test('env --empty-home: temp HOME + Claude config, no provider/XDG env, home installs allowed (they land in the temp HOME)', () => {
  const env = build({ emptyHome: true })
  expect(env).toMatchObject({ ...OWNED, HOME: paths.home, CLAUDE_CONFIG_DIR: paths.claude, PATH: '/a:/b', SHELL: '/bin/zsh' })
  for (const k of [...STRIPPED.filter((x) => x !== 'WEBTERM_DATA_DIR' && x !== 'PORT'), 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'ZDOTDIR', 'XDG_CONFIG_HOME', SKIP_HOME_INSTALLS_ENV]) expect(env[k]).toBe(undefined)
})

test('.env is loaded like `bun run dev` (caller wins, ${VAR} expanded) but cannot redirect the fresh data dir or port', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'devfresh-dotenv-'))
  try {
    // test-only values
    writeFileSync(join(cwd, '.env'), 'WEBTERM_DATA_DIR=/Users/me/.webterm-server\nPORT=8700\nWEBTERM_TOKEN=x\nNODETERM_PORT=8700\nFROM_FILE=${LANG}-f\nLANG=file\n')
    writeFileSync(join(cwd, '.env.local'), 'ANTHROPIC_BASE_URL=http://local\n')
    const merged = withDotenv({ PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test' }, cwd)
    expect(merged).toMatchObject({ FROM_FILE: 'en_US.UTF-8-f', LANG: 'en_US.UTF-8', ANTHROPIC_BASE_URL: 'http://local' })
    const env = buildFreshEnv(merged, { paths, port: 8710, proxyPort: 8711, noClaude: false, emptyHome: false })
    expect(env).toMatchObject({ ...OWNED, ANTHROPIC_BASE_URL: 'http://local', FROM_FILE: 'en_US.UTF-8-f' })
    expect(env.WEBTERM_TOKEN).toBe(undefined)
    expect(env.NODETERM_PORT).toBe(undefined)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('--no-claude drops every PATH dir holding claude', () => {
  expect(build({ noClaude: true }).PATH).toBe('/a')
  expect(pathWithout('/x::/y:/z', 'claude', (d) => d === '/y')).toBe('/x:/z')
})

test('the fresh tmux socket is never the real one', () => {
  expect(supervisorSocket(paths.data)).not.toBe(supervisorSocket(undefined))
  expect(supervisorSocket(paths.data)).not.toBe(supervisorSocket('/Users/me/.webterm-server'))
})

test('flags parse; bad input throws', () => {
  expect(parseFreshArgs(['--port', '8800', '--keep', '--no-claude', '--empty-home'])).toEqual({ port: 8800, keep: true, noClaude: true, emptyHome: true, clean: false })
  expect(parseFreshArgs([])).toEqual({ keep: false, noClaude: false, emptyHome: false, clean: false })
  expect(thrown(() => parseFreshArgs(['--with-provider-env']))).toMatch('unknown flag') // its behaviour is the default now
  expect(parseFreshArgs(['--clean']).clean).toBe(true)
  expect(thrown(() => parseFreshArgs(['--port', 'x']))).toMatch('--port needs a port')
  expect(thrown(() => parseFreshArgs(['--nope']))).toMatch('unknown flag')
})

test('findFreePort never returns the real instance ports', async () => {
  expect(RESERVED_PORTS).toEqual([8700, 8701])
  const p = await findFreePort(8700)
  expect(RESERVED_PORTS).not.toContain(p)
})

test('cleanup refuses anything that is not its own temp root', () => {
  const base = mkdtempSync(join(tmpdir(), 'devfresh-base-'))
  try {
    const other = join(base, 'not-fresh')
    mkdirSync(other)
    expect(thrown(() => removeFreshRoot(other, base))).toMatch('refusing to delete')
    expect(existsSync(other)).toBe(true)
    mkdirSync(join(base, 'sub', 'webterm-fresh-1'), { recursive: true })
    expect(thrown(() => assertFreshRoot(join(base, 'sub', 'webterm-fresh-1'), base))).toMatch('refusing') // nested, not direct child
    expect(thrown(() => assertFreshRoot(join(base, 'webterm-fresh-1', '..', 'not-fresh'), base))).toMatch('refusing')
    const own = makeFreshRoot(base)
    expect(existsSync(own.data) && existsSync(own.home) && existsSync(own.claude)).toBe(true)
    removeFreshRoot(own.root, base)
    expect(existsSync(own.root)).toBe(false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

const stops: Array<() => Promise<void>> = []
afterAll(async () => { for (const s of stops) await s() })

// Skipped only on CI without tmux (no supervisor to exercise); locally it always runs.
const smoke = process.env.CI && !findOnPath('tmux') ? 'skip' : 'run'
test('smoke (' + smoke + '): boots an isolated server, /api/health needs a token, stop deletes the root', async () => {
  if (smoke === 'skip') return
  const fakeBin = mkdtempSync(join(tmpdir(), 'devfresh-bin-'))
  const calls = fakeSecurity(fakeBin)
  const savedPath = process.env.PATH
  process.env.PATH = `${fakeBin}:${savedPath}` // stop() deletes keychain items: never the real `security` in tests
  // --empty-home keeps the smoke hermetic (no real HOME/.env/Claude login in a test run).
  const fresh = await startFresh({ keep: false, noClaude: false, emptyHome: true, clean: false }, 'pipe')
    .finally(() => stops.push(async () => { process.env.PATH = savedPath; rmSync(fakeBin, { recursive: true, force: true }) }))
  stops.unshift(fresh.stop) // stop (fake `security` still on PATH) before PATH is restored
  expect(RESERVED_PORTS).not.toContain(fresh.port)
  expect(fresh.paths.root.startsWith(realpathSync(tmpdir()) + '/webterm-fresh-')).toBe(true)
  await waitForHttp(`${fresh.url}/api/health`, 60_000, fresh.child)
  expect((await fetch(`${fresh.url}/api/health`)).status).toBe(403)
  expect(existsSync(join(fresh.paths.data, 'webterm.db'))).toBe(true)
  expect(existsSync(join(fresh.paths.data, 'secrets', 'WEBTERM_TOKEN'))).toBe(true)
  expect(existsSync(freshSetupCodePath(fresh.paths))).toBe(true) // the banner names this file: a fresh install has no account
  await fresh.stop()
  expect(existsSync(fresh.paths.root)).toBe(false)
  expect(calls()).toContain(`-s Claude Code-credentials-`)
}, 90_000)
