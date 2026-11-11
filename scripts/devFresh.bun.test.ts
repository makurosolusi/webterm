import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'
import { fakeSecurity } from './devFresh.testutil'
import {
  RESERVED_PORTS, assertFreshRoot, buildFreshEnv, findFreePort, freshPaths, freshSetupCodePath, makeFreshRoot, parseFreshArgs,
  pathWithout, removeFreshRoot, startFresh, waitForHttp,
} from './devFresh'

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
const build = (o: { withProviderEnv?: boolean; noClaude?: boolean } = {}) =>
  buildFreshEnv(realEnv, { paths, port: 8710, proxyPort: 8711, noClaude: !!o.noClaude, withProviderEnv: !!o.withProviderEnv, has: (d) => d === '/b' })

test('env: fresh dirs and ports are set, the real install is stripped', () => {
  const env = build()
  expect(env).toMatchObject({
    WEBTERM_DATA_DIR: paths.data, HOME: paths.home, CLAUDE_CONFIG_DIR: paths.claude, WEBTERM_VITE_CACHE_DIR: paths.vite,
    PORT: '8710', WEBTERM_PROXY_PORT: '8711', PATH: '/a:/b', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
  })
  for (const k of ['WEBTERM_TOKEN', 'NODETERM_PORT', 'TMUX', 'TMUX_PANE', 'NODE_ENV', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDECODE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ZDOTDIR', 'XDG_CONFIG_HOME']) expect(env[k]).toBe(undefined)
})

test('env: --with-provider-env keeps ANTHROPIC_/CLAUDE_CODE_ but still strips webterm, tmux and the config dir', () => {
  const env = build({ withProviderEnv: true })
  expect(env.ANTHROPIC_API_KEY).toBe('k')
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  expect(env.CLAUDE_CONFIG_DIR).toBe(paths.claude)
  expect(env.WEBTERM_TOKEN).toBe(undefined)
  expect(env.TMUX).toBe(undefined)
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
  expect(parseFreshArgs(['--port', '8800', '--keep', '--no-claude', '--with-provider-env'])).toEqual({ port: 8800, keep: true, noClaude: true, withProviderEnv: true, clean: false })
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
  const fresh = await startFresh({ keep: false, noClaude: false, withProviderEnv: false, clean: false }, 'pipe')
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
