// Bun-only (bun:sqlite). tool_cache core: hit on the same version, miss on a new one; source version helpers.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgerDb } from '../ledger/migration'
import { cachedToolRead, stableJson, toolCacheKey } from './toolCache'
import { gitTreeVersion } from './toolCacheGit'

const T0 = 1_700_000_000_000 // test-only clock

function counter() {
  let calls = 0
  return { run: () => { calls += 1; return { n: calls } }, get calls() { return calls } }
}

test('same version is a hit, a new version is a miss, keep=false stores nothing', async () => {
  const db = openLedgerDb(':memory:')
  const c = counter()
  const read = (version: string) => cachedToolRead(db, { tool: 'repo.map', args: { root: '/r', budget: 1 }, version }, c.run, T0)
  expect(await read('v1')).toEqual({ value: { n: 1 }, hit: false })
  expect(await read('v1')).toEqual({ value: { n: 1 }, hit: true })
  expect(await read('v2')).toEqual({ value: { n: 2 }, hit: false })
  expect(c.calls).toBe(2)
  await cachedToolRead(db, { tool: 'git.diff', args: {}, version: 'v' }, c.run, T0, () => false)
  await cachedToolRead(db, { tool: 'git.diff', args: {}, version: 'v' }, c.run, T0, () => false)
  expect(c.calls).toBe(4)
})

test('args are normalised: key order does not matter, values do', () => {
  expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  expect(toolCacheKey('git.diff', { a: 1, b: 2 })).toBe(toolCacheKey('git.diff', { b: 2, a: 1 }))
  expect(toolCacheKey('git.diff', { a: 1 }) === toolCacheKey('git.diff', { a: 2 })).toBe(false)})

test('git tree version changes on an unstaged edit, a commit and a new file; not a repo throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-git-'))
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(dir, 'f'), '1')
  git('add', 'f'); git('commit', '-qm', 'one')
  const v1 = await gitTreeVersion(dir)
  expect(await gitTreeVersion(dir)).toBe(v1)
  writeFileSync(join(dir, 'f'), '22')
  const v2 = await gitTreeVersion(dir)
  expect(v2 === v1).toBe(false)
  git('commit', '-qam', 'two')
  const v3 = await gitTreeVersion(dir)
  expect(v3 === v2 || v3 === v1).toBe(false)
  writeFileSync(join(dir, 'new'), 'x')
  expect((await gitTreeVersion(dir)) === v3).toBe(false)
  const err = await gitTreeVersion(mkdtempSync(join(tmpdir(), 'tc-nogit-'))).then(() => null, (e: Error) => e.message)
  expect(err).toContain('not a git work tree')
})

test('tools outside the R0 allowlist (project.list included) are refused', async () => {
  const db = openLedgerDb(':memory:')
  for (const tool of ['node.kill', 'project.list']) {
    const err = await cachedToolRead(db, { tool: tool as never, args: {}, version: '1' }, () => 1, T0).then(() => null, (e: Error) => e.message)
    expect(err).toContain('not a cacheable')
  }
})
