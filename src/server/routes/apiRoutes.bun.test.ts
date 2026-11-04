// Bun-only: the route table pulls bun:sqlite through ../db. Guards the ORDER of API_ROUTES: the
// first entry that answers wins, so a reorder can silently change which family (and auth gate)
// sees a request.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-routes-')) // before ../api -> ../db opens
const { API_ROUTES } = await import('../api')
const names = API_ROUTES.map((r) => r.name)
const at = (name: string): number => {
  const i = names.indexOf(name)
  if (i < 0) throw new Error(`route ${name} missing from API_ROUTES`)
  return i
}

test('full route order snapshot', () => {
  expect(names).toEqual([
    'logs', 'events', 'timeline',
    'workspaces', 'session-history',
    'browser',
    'env-settings', 'env-import', 'capabilities', 'agent-protection', 'custom-agents-preview', 'settings',
    'fs-verbs', 'hygiene',
    'git-info', 'git-diff', 'checkpoint', 'git-scm',
    'brief',
    'workspace-worktree',
    'ports', 'problems', 'tasks',
    'outbox',
    'agent-status', 'tools', 'mcp', 'control', 'context-link',
    'generate-name', 'folder-picker',
    'central-chat', 'ca2', 'extended',
    'approval-human', 'policy', 'secrets', 'procedural',
    'memory-write', 'inbox', 'memory', 'orchestrator',
  ])
})

test('route names are unique', () => {
  expect(new Set(names).size).toBe(names.length)
})

test('auth-sensitive ordering invariants', () => {
  // Pair carries the names so a failure reads "mcp before control: false".
  const before = (a: string, b: string) => expect(`${a} before ${b}: ${at(a) < at(b)}`).toBe(`${a} before ${b}: true`)
  // /api/control/mcp/* nests inside the control family: mcp must claim it first.
  before('mcp', 'control')
  // UI-only families (agent credentials get 403) must win over the generic ledger memory writes.
  for (const uiOnly of ['policy', 'secrets', 'procedural']) before(uiOnly, 'memory-write')
  // Memory writes read the body lazily so the read-only projections after them never touch it.
  for (const read of ['inbox', 'memory', 'orchestrator']) before('memory-write', read)
  // Central chat SSE must be mounted before the read-only projections and the 404 fallback.
  for (const read of ['inbox', 'memory', 'orchestrator']) before('central-chat', read)
  // Env settings are mounted before /api/settings.
  before('env-settings', 'settings')
  // fs verbs (/api/fs/<verb>) before the exact /api/fs folder picker.
  before('fs-verbs', 'folder-picker')
  // Sensor families sit between worktree workspaces and the outbox; their UI-only POSTs (node
  // token -> 403) are asserted through the real router in sensors.routes.bun.test.ts.
  for (const s of ['ports', 'problems', 'tasks']) { before('workspace-worktree', s); before(s, 'outbox') }
  // Log API first: own body/SSE handling ahead of everything.
  expect(at('logs')).toBe(0)
})
