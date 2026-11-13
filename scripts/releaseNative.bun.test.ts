// release:native's core (scripts/releaseNative.ts) without a real build: the refusal for an existing version
// folder, and which artifacts it gathers.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNewRelease, collectArtifacts, releaseDir } from './releaseNative'

const root = mkdtempSync(join(tmpdir(), 'wt-release-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
/** Message of what `fn` throws ('' when it does not throw); this tsconfig's bun:test typings lack toThrow. */
const thrown = (fn: () => unknown): string => { try { fn(); return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }

test('a version that already has a release folder is refused, telling the user to bump package.json', () => {
  expect(thrown(() => assertNewRelease(root, '1.2.3'))).toBe('')
  mkdirSync(releaseDir(root, '1.2.3'), { recursive: true })
  expect(thrown(() => assertNewRelease(root, '1.2.3'))).toMatch(/release 1\.2\.3 already exists.*bump "version" in package\.json/)
  expect(thrown(() => assertNewRelease(root, '1.2.4'))).toBe('')
})

test('collects only this build\'s stable update files', () => {
  const art = join(root, 'artifacts')
  mkdirSync(art)
  const files = ['stable-macos-arm64-update.json', 'stable-macos-arm64-update-v2.json', 'stable-macos-arm64-abc.tar.zst', 'stable-macos-arm64-old.patch', 'canary-macos-arm64-update.json', 'notes.txt']
  for (const f of files) writeFileSync(join(art, f), 'x')
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(art, 'stable-macos-arm64-old.patch'), old, old) // a leftover from an earlier build
  const dest = releaseDir(root, '2.0.0')
  const names = collectArtifacts(art, dest, Date.now() - 10_000)
  expect(names).toEqual(['stable-macos-arm64-abc.tar.zst', 'stable-macos-arm64-update-v2.json', 'stable-macos-arm64-update.json'])
  expect(readdirSync(dest).sort()).toEqual(names)
})

test('a build without an update manifest is an error', () => {
  const art = join(root, 'empty-artifacts')
  mkdirSync(art)
  writeFileSync(join(art, 'stable-macos-arm64-abc.tar.zst'), 'x')
  expect(thrown(() => collectArtifacts(art, join(root, 'out'), 0))).toMatch(/no update manifest/)
})
