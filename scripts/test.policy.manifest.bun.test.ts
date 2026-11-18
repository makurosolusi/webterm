// Keeps scripts/test.policy.manifest.ts honest: every scanner-style test in the repo must be listed
// there (otherwise `test:impacted` would silently skip it), and nothing listed may be gone.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { discoverScanners } from './test.policy.discover'
import { policyFiles } from './test.policy.manifest'

const ROOT = join(import.meta.dirname, '..')
const HOW_TO_FIX = 'add it to scripts/test.policy.manifest.ts (under the domain of the tree it scans)'

// Only src/ and scripts/: walking the repo root would descend into node_modules.
const repoFiles = ['src', 'scripts'].flatMap((d) =>
  (readdirSync(join(ROOT, d), { recursive: true }) as string[]).map((f) => `${d}/${f.split('\\').join('/')}`),
)

test('every scanner-style test is in the policy manifest', () => {
  const listed = new Set(policyFiles())
  const missing = discoverScanners(repoFiles, (f) => readFileSync(join(ROOT, f), 'utf8')).filter((f) => !listed.has(f))
  expect(missing.map((f) => `${f}: not in the policy manifest, ${HOW_TO_FIX}`)).toEqual([])
})

test('every manifest entry exists', () => {
  const gone = policyFiles().filter((f) => !existsSync(join(ROOT, f)))
  expect(gone.map((f) => `${f}: listed in the policy manifest but missing on disk, remove or rename the entry in scripts/test.policy.manifest.ts`)).toEqual([])
})

test('no manifest entry is listed twice or is not a test file', () => {
  const all = policyFiles()
  expect(all.filter((f, i) => all.indexOf(f) !== i)).toEqual([])
  expect(all.filter((f) => !/\.test\.tsx?$/.test(f))).toEqual([])
})
