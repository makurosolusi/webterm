// Quick Open server: sumber rg -> git -> penelusuran fs, .gitignore, cap, dan penolakan keluar-root.
// Matcher dibatasi `bun-test.d.ts` (toBe/toContain), jadi daftar dibandingkan lewat JSON.
import { afterAll, expect, test as it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEARCH_MATCH_ALL, SEARCH_MAX_RESULTS, searchFiles } from './fsSearch'

const base = mkdtempSync(join(tmpdir(), 'wt-search-'))
const repo = join(base, 'repo')
const outside = join(base, 'outside')
const plain = join(base, 'plain')
const gitBin = join(base, 'gitbin')
const emptyBin = join(base, 'emptybin')
const put = (dir: string, rel: string, body = 'x') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), body) }
afterAll(() => rmSync(base, { recursive: true, force: true }))

for (const d of [repo, outside, gitBin, emptyBin]) mkdirSync(d)
execFileSync('git', ['init', '-q'], { cwd: repo })
put(repo, '.gitignore', 'ignored/\n*.log\n')
put(repo, 'src/app.ts')
put(repo, 'src/deep/Util.ts')
put(repo, 'README.md')
put(repo, 'ignored/secret.txt')
put(repo, 'debug.log')
put(repo, 'with space/new\nline.txt')
put(outside, 'leak.txt')
symlinkSync(join(outside, 'leak.txt'), join(repo, 'link-out.txt'))
symlinkSync(join(repo, 'README.md'), join(repo, 'link-in.md'))
put(plain, 'a/b.txt')
put(plain, 'node_modules/pkg/index.js')
const gitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
symlinkSync(gitPath, join(gitBin, 'git'))

const search = async (root: string, q = SEARCH_MATCH_ALL, limit?: number, pathEnv?: string) => {
  const env = pathEnv === undefined ? undefined : { ...process.env, PATH: pathEnv }
  const r = await searchFiles(root, q, limit, env)
  if (!r.ok) throw new Error(`search failed: ${r.code}`)
  return r
}
const failCode = async (root: string) => { const r = await searchFiles(root, SEARCH_MATCH_ALL); return r.ok ? 'ok' : r.code }

it('lists files relative to root, honours .gitignore, hides .git, drops outside symlinks', async () => {
  const r = await search(repo)
  expect(r.files).toContain('src/app.ts')
  expect(r.files).toContain('.gitignore')
  expect(r.files).toContain('with space/new\nline.txt')
  expect(r.files.includes('ignored/secret.txt')).toBe(false)
  expect(r.files.includes('debug.log')).toBe(false)
  expect(r.files.includes('link-out.txt')).toBe(false)
  expect(r.files.some((f) => f.startsWith('.git/'))).toBe(false)
  expect(r.files.every((f) => !f.startsWith('/') && !f.split('/').includes('..'))).toBe(true)
  expect(r.truncated).toBe(false)
})

it('filters by case-insensitive subsequence', async () => {
  expect(JSON.stringify((await search(repo, 'SRCUTIL')).files)).toBe('["src/deep/Util.ts"]')
  expect(JSON.stringify((await search(repo, 'zzzz')).files)).toBe('[]')
})

it('falls back to git ls-files when rg is not on PATH', async () => {
  const r = await search(repo, SEARCH_MATCH_ALL, undefined, gitBin)
  expect(r.files).toContain('src/app.ts')
  expect(r.files.includes('ignored/secret.txt')).toBe(false)
  expect(r.files.includes('debug.log')).toBe(false)
  // Hanya git yang mendaftar symlink: yang di dalam root tetap, yang keluar root dibuang.
  expect(r.files).toContain('link-in.md')
  expect(r.files.includes('link-out.txt')).toBe(false)
})

it('falls back to the fs walk when neither rg nor git exist (node_modules skipped)', async () => {
  const r = await search(plain, SEARCH_MATCH_ALL, undefined, emptyBin)
  expect(JSON.stringify(r.files)).toBe('["a/b.txt"]')
})

it('caps results and flags truncated; cap constant is 50.000', async () => {
  expect(SEARCH_MAX_RESULTS).toBe(50_000)
  const r = await search(repo, SEARCH_MATCH_ALL, 2)
  expect(r.files.length).toBe(2)
  expect(r.truncated).toBe(true)
  const huge = await search(repo, SEARCH_MATCH_ALL, SEARCH_MAX_RESULTS * 10)
  expect(huge.truncated).toBe(false)
})

it('rejects relative, NUL, missing and non-directory roots', async () => {
  expect(await failCode('../etc')).toBe('EINVAL')
  expect(await failCode('relative/dir')).toBe('EINVAL')
  expect(await failCode(`${repo}\0x`)).toBe('EINVAL')
  expect(await failCode(join(repo, 'nope'))).toBe('ENOENT')
  expect(await failCode(join(repo, 'README.md'))).toBe('ENOTDIR')
})

it('never hands q to a process: shell metacharacters are just a non-matching filter', async () => {
  const marker = join(base, 'pwned')
  const r = await search(repo, `$(touch ${marker});\`x\``)
  expect(r.files.length).toBe(0)
  expect(existsSync(marker)).toBe(false)
})
