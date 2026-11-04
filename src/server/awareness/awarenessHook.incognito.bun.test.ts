// Bun-only (bun:sqlite). F5-b on the SessionStart awareness reply: the shared blackboard summary rides along,
// and an incognito node gets its identity card only (no procedural memory, no blackboard, no project rules).
// Also pins that the consolidator never starts under a test runner (no model can be reached from here).
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { BLACKBOARD_SUMMARY_HEADER, writeBlackboard } from '../blackboard/blackboard.store'
import { activeConsolidator, underTestRunner } from '../memory/consolidator/consolidator.boot'
import { nodeRef, setIncognito } from '../memory/memoryControls'
import { fixture } from '../memory/memoryV2.fixture'
import { awarenessExtras, projectRules } from './awarenessHook'
import { addProcedural, HUMAN_UI, PROCEDURAL_BLOCK_HEADER } from './proceduralMemory'

const cwd = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'aw-incognito-'))
writeFileSync(join(cwd, 'AGENTS.md'), 'Always run the zebra suite.\n')
for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']]) spawnSync('git', ['-C', cwd, ...args])
const ws = (id: string): Workspace => ({
  id: 'w1', name: 'Board', cwd, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  nodes: [{ id, kind: 'agent', agentId: 'claude', x: 0, y: 0, title: 'Main', cwd }], bridges: [],
}) as unknown as Workspace

test('SessionStart carries procedural memory, the blackboard and rules; an incognito node gets the card only', async () => {
  const db = fixture()
  await projectRules.warm(cwd)
  addProcedural(db, HUMAN_UI, 'Always run tests with TMPDIR=/tmp/st')
  writeBlackboard(db, { kind: 'human', id: 'human-ui' }, 'goal:auth/status', 'in progress', Date.now())
  const open = awarenessExtras('n-open', 'SessionStart', ws('n-open'), db) ?? ''
  expect(open).toContain('webterm card: node "Main"')
  expect(open).toContain(PROCEDURAL_BLOCK_HEADER)
  expect(open).toContain(`${BLACKBOARD_SUMMARY_HEADER}\n- goal:auth/status: in progress`)
  expect(open).toContain('Always run the zebra suite.')

  setIncognito(db, { kind: 'human', id: 'human-ui' }, nodeRef('n-secret'), true, Date.now())
  const secret = awarenessExtras('n-secret', 'SessionStart', ws('n-secret'), db) ?? ''
  expect(secret).toContain('webterm card: node "Main"')
  expect(secret).not.toContain(PROCEDURAL_BLOCK_HEADER)
  expect(secret).not.toContain('TMPDIR=/tmp/st')
  expect(secret).not.toContain(BLACKBOARD_SUMMARY_HEADER)
  expect(secret).not.toContain('zebra')
  // Later hooks of an incognito node carry no rules either.
  expect(awarenessExtras('n-secret', 'UserPromptSubmit', ws('n-secret'), db)).toBeNull()
})

test('the consolidator is not started under a test runner', () => {
  expect(activeConsolidator()).toBeNull()
  // Holds even when an earlier file leaked NODE_ENV=production into this process.
  expect(underTestRunner({ NODE_ENV: 'production' }, ['bun', '/x/a.bun.test.ts'])).toBe(true)
  expect(underTestRunner({ NODE_ENV: 'production' }, ['bun', 'src/server/index.ts'])).toBe(false)
})
