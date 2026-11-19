// Find in Files: rg --json pages, .gitignore, cancellation by searchId, and the no-rg fallback.
import { afterAll, expect, test as it } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from './binaryOnPath'
import { cancelGrep, grepFiles, parseRgLine } from './fsGrep'
import { GREP_VERBS } from './fsGrep.route'

const base = mkdtempSync(join(tmpdir(), 'wt-grep-'))
const repo = join(base, 'repo')
const gitBin = join(base, 'gitbin')
const put = (rel: string, body: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), body) }
afterAll(() => rmSync(base, { recursive: true, force: true }))

mkdirSync(repo)
mkdirSync(gitBin)
execFileSync('git', ['init', '-q'], { cwd: repo })
put('.gitignore', 'ignored/\n')
put('a.ts', 'const needle = 1\nnothing\nNEEDLE again\n')
put('b/c.ts', 'x\nneedle here\n')
put('ignored/x.ts', 'needle hidden\n')
put('bin.dat', 'needle\0binary')
// 30 matches for the pagination test, one file so order is by line.
put('many.txt', Array.from({ length: 30 }, (_, i) => `hit ${i}`).join('\n'))
symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(gitBin, 'git'))
const noRg = { ...process.env, PATH: gitBin } // git only: rg missing → fallback

const ok = async (...args: Parameters<typeof grepFiles>) => {
  const r = await grepFiles(...args)
  if (!r.ok) throw new Error(`grep failed: ${r.code} ${r.error}`)
  return r
}
const where = (ms: { file: string; line: number }[]) => JSON.stringify(ms.map((m) => `${m.file}:${m.line}`))

it('finds literal, case-insensitive matches with line/col, honours .gitignore, skips binaries', async () => {
  const r = await ok(repo, 'needle')
  // The rg path is only meaningful where rg is installed (CI installs it); the fallback is always tested below.
  expect(r.engine).toBe(findOnPath('rg') ? 'rg' : 'fallback')
  expect(where(r.matches)).toBe('["a.ts:1","a.ts:3","b/c.ts:2"]')
  expect(r.matches[0].col).toBe(7)
  expect(r.matches[0].text).toBe('const needle = 1')
  expect(r.nextOffset).toBeNull()
})

it('paginates with offset/limit and stable order across pages', async () => {
  const p1 = await ok(repo, 'hit', { limit: 10 })
  expect(p1.matches.length).toBe(10)
  expect(p1.nextOffset).toBe(10)
  const p3 = await ok(repo, 'hit', { offset: 20, limit: 10 })
  expect(p3.matches[0].text).toBe('hit 20')
  expect(p3.nextOffset).toBeNull()
  const capped = await ok(repo, 'hit', { limit: 100_000 })
  expect(capped.matches.length).toBe(30) // GREP_PAGE_MAX clamps, it does not reject
})

it('a newer search with the same searchId cancels the in-flight one; cancelGrep stops it too', async () => {
  // Fallback engine checks cancellation between files, so the first search is reliably still running.
  const first = grepFiles(repo, 'needle', { searchId: 's1', env: noRg })
  const second = await ok(repo, 'hit', { searchId: 's1' })
  expect(second.cancelled).toBe(false)
  const r1 = await first
  expect(r1.ok && r1.cancelled).toBe(true)
  const third = grepFiles(repo, 'needle', { searchId: 's2', env: noRg })
  expect(cancelGrep('s2')).toBe(true)
  const r3 = await third
  expect(r3.ok && r3.cancelled && r3.nextOffset === null).toBe(true)
  expect(cancelGrep('s2')).toBe(false) // finished searches leave nothing behind
})

it('falls back to the existing listing + line scan when rg is missing, and says so', async () => {
  const r = await ok(repo, 'needle', { env: noRg })
  expect(r.engine).toBe('fallback')
  expect(where(r.matches)).toBe('["a.ts:1","a.ts:3","b/c.ts:2"]')
  const page = await ok(repo, 'hit', { env: noRg, limit: 5, offset: 5 })
  expect(page.matches[0].text).toBe('hit 5')
  expect(page.nextOffset).toBe(10)
})

it('rejects a bad root and an over-long query', async () => {
  const notDir = await grepFiles(join(repo, 'a.ts'), 'x')
  expect(notDir.ok ? 'ok' : notDir.code).toBe('ENOTDIR')
  const long = await grepFiles(repo, 'x'.repeat(1001))
  expect(long.ok ? 'ok' : long.code).toBe('EINVAL')
})

it('parses only rg match messages', () => {
  expect(parseRgLine('{"type":"begin","data":{"path":{"text":"a"}}}')).toBeNull()
  expect(parseRgLine('not json')).toBeNull()
  const m = parseRgLine('{"type":"match","data":{"path":{"text":"./x/y.ts"},"lines":{"text":"ab\\n"},"line_number":4,"submatches":[{"start":1,"end":2}]}}')
  expect(JSON.stringify(m)).toBe('{"file":"x/y.ts","line":4,"col":2,"text":"ab"}')
})

it('route verbs read offset/limit/searchId from the query', async () => {
  const q = new URLSearchParams({ offset: '28', limit: '5', searchId: 'r1' })
  const r = (await GREP_VERBS.grep.run({ root: repo, q: 'hit' }, {}, {}, q)) as { matches: unknown[]; nextOffset: number | null }
  expect(r.matches.length).toBe(2)
  expect(r.nextOffset).toBeNull()
  const c = (await GREP_VERBS['grep-cancel'].run({ searchId: 'nope' }, {}, {}, new URLSearchParams())) as { cancelled: boolean }
  expect(c.cancelled).toBe(false)
})

// test-only: a spawn that fails like the runtime does (async 'error', then 'close', no process).
const spawnFailing = (code: string) => (() => {
  const p = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, kill: () => true })
  queueMicrotask(() => { p.emit('error', Object.assign(new Error(`spawn rg ${code}`), { code })); p.emit('close', -2) })
  return p
}) as unknown as typeof spawn

it('only ENOENT means rg is missing; EMFILE/EAGAIN are errors, never an empty success', async () => {
  const missing = await ok(repo, 'needle', { spawn: spawnFailing('ENOENT') })
  expect(missing.engine).toBe('fallback')
  expect(missing.matches.length).toBe(3)
  for (const code of ['EMFILE', 'EAGAIN']) {
    const r = await grepFiles(repo, 'needle', { spawn: spawnFailing(code) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(`could not run rg (${code})`)
  }
})

it('a failed fallback listing is an error, not zero matches', async () => {
  const r = await grepFiles(repo, 'needle', { spawn: spawnFailing('ENOENT'), list: async () => ({ ok: false, code: 'EIO', error: 'search failed: spawn git EMFILE' }) })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toBe('content search fallback could not list files (EIO): search failed: spawn git EMFILE')
  const empty = await ok(repo, 'zzz-no-such-text') // a real empty search stays ok
  expect(empty.matches).toEqual([])
})
