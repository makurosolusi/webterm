// The embedded skill list must match builtin/ on disk, and a `--compile` binary must carry the texts
// (root cause of "built-in skills never install" in the release binary: builtin/ only exists in /$bunfs).
import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_SKILLS } from './builtinSkills.embedded'
import { BUILTIN_DIR, readBuiltinDir } from './skillStore'

const COMPILE_TIMEOUT_MS = 30_000
const box = mkdtempSync(join(tmpdir(), 'wt-skills-'))
afterAll(() => rmSync(box, { recursive: true, force: true }))

test('BUILTIN_SKILLS lists every builtin/ folder with its exact SKILL.md text', () => {
  expect(BUILTIN_SKILLS).toEqual(readBuiltinDir(BUILTIN_DIR))
})

test('a --compile binary installs every builtin skill from the embedded texts', () => {
  const probe = join(box, 'probe.ts')
  writeFileSync(probe, [
    "import { Database } from 'bun:sqlite'",
    `import { BUILTIN_SKILLS } from ${JSON.stringify(join(import.meta.dirname, 'builtinSkills.embedded.ts'))}`,
    `import { createSkillStore } from ${JSON.stringify(join(import.meta.dirname, 'skillStore.ts'))}`,
    'const store = createSkillStore({ db: new Database(":memory:"), root: process.argv[2], builtins: BUILTIN_SKILLS })',
    'console.log(JSON.stringify(store.installBuiltins().map((r) => r.name)))',
  ].join('\n'))
  const bin = join(box, 'probe-bin')
  const build = spawnSync(process.execPath, ['build', '--compile', '--no-compile-autoload-bunfig', '--outfile', bin, probe], { encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS })
  expect(build.status).toBe(0)
  const r = spawnSync(bin, [join(box, 'skills')], { encoding: 'utf8', cwd: box, timeout: COMPILE_TIMEOUT_MS })
  expect(r.stderr).toBe('')
  expect(JSON.parse(r.stdout)).toEqual(Object.keys(BUILTIN_SKILLS).sort())
}, COMPILE_TIMEOUT_MS * 2)
