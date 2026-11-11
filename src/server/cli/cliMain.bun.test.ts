// The real entry (index.ts, and a `--compile` binary of it) with CLI flags: exit codes, output, and
// no side effects. A flag run must create neither the data dir nor anything webterm-owned in HOME
// (Bun's own transpiler cache under HOME/Library/Caches is the runtime's, not ours).
import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../../../package.json'

const ENTRY = join(import.meta.dirname, '../index.ts')
const RUN_TIMEOUT_MS = 20_000
const COMPILE_TIMEOUT_MS = 60_000
const BUN_CACHE_DIR = 'Library'
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function sandbox(): { home: string; dataDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'wt-cli-'))
  dirs.push(home)
  return { home, dataDir: join(home, 'data') }
}

function run(cmd: string[], args: string[]): { code: number | null; out: string; err: string; home: string; dataDir: string } {
  const box = sandbox()
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd: box.home, encoding: 'utf8', timeout: RUN_TIMEOUT_MS,
    env: { HOME: box.home, WEBTERM_DATA_DIR: box.dataDir, PATH: process.env.PATH ?? '' },
  })
  return { code: r.status, out: r.stdout, err: r.stderr, ...box }
}

function expectNoSideEffects(r: { home: string; dataDir: string }): void {
  expect(existsSync(r.dataDir)).toBe(false)
  expect(readdirSync(r.home).filter((n) => n !== BUN_CACHE_DIR)).toEqual([])
}

const DEV = [process.execPath, '--no-env-file', ENTRY]

test('--help prints usage and exits 0 without touching the data dir', () => {
  const r = run(DEV, ['--help'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('Usage: webterm [options]')
  expect(r.out).toContain('WEBTERM_DATA_DIR')
  expectNoSideEffects(r)
}, RUN_TIMEOUT_MS)

test('--version prints the package version and exits 0', () => {
  const r = run(DEV, ['--version'])
  expect(r.code).toBe(0)
  expect(r.out).toBe(`webterm ${pkg.version} (dev)\n`)
  expectNoSideEffects(r)
}, RUN_TIMEOUT_MS)

test('an unknown flag exits 2 with a hint on stderr and never starts the server', () => {
  const r = run(DEV, ['--bogus'])
  expect(r.code).toBe(2)
  expect(r.out).toBe('')
  expect(r.err).toContain("webterm: unknown option '--bogus'")
  expect(r.err).toContain("Run 'webterm --help'")
  expectNoSideEffects(r)
}, RUN_TIMEOUT_MS)

test('--readme prints the embedded README when stdout is not a terminal; --docs env the env reference', () => {
  const r = run(DEV, ['--readme'])
  expect(r.code).toBe(0)
  expect(r.out.startsWith('# webterm\n')).toBe(true)
  const d = run(DEV, ['--docs', 'env'])
  expect(d.code).toBe(0)
  expect(d.out).toContain('# Environment variables')
  const bad = run(DEV, ['--docs', 'nope'])
  expect(bad.code).toBe(2)
  expect(bad.err).toContain('topics: ')
  expectNoSideEffects(bad)
}, RUN_TIMEOUT_MS)

test('a --compile binary of the entry answers --version and --bogus', () => {
  const box = sandbox()
  const out = join(box.home, 'webterm-bin')
  const build = spawnSync(process.execPath, ['build', '--compile', '--no-compile-autoload-bunfig', '--external', 'vite', '--outfile', out, ENTRY], { encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS })
  expect(build.status).toBe(0)
  const v = run([out], ['--version'])
  expect(v.code).toBe(0)
  expect(v.out).toContain(`webterm ${pkg.version} (`)
  expectNoSideEffects(v)
  expect(run([out], ['--bogus']).code).toBe(2)
}, COMPILE_TIMEOUT_MS + RUN_TIMEOUT_MS)
