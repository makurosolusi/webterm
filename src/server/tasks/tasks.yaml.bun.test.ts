// Real files + Bun.YAML: the production TaskFs reads a workspace folder.
import { afterAll, expect, test as it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTasks, nodeTaskFs } from './tasks.list'

const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('lists orca.yaml scripts and package.json scripts from disk', async () => {
  writeFileSync(join(dir, 'orca.yaml'), 'scripts:\n  setup: |\n    pnpm install\ndefaultTabs:\n  - title: Dev\n    command: pnpm dev\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -b' } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  expect((await listTasks(dir, nodeTaskFs)).map((t) => [t.id, t.run])).toEqual([
    ['orca.yaml:setup', 'pnpm install'],
    ['orca.yaml:tab:Dev', 'pnpm dev'],
    ['package.json:build', 'pnpm run build'],
  ])
})
