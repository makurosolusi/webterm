// Bun-only. tool_cache wired into git.diff (node MCP) and repo.map: a repeat call with an unchanged source
// is served from the cache; an unstaged edit, a new file or a commit is not.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { freshDb } from '../central/guard/controlGuard.testutil'
import { ALLOW_ALL_GUARD } from '../central/tools/toolExec'
import { createRegistry } from '../central/tools/toolRegistry'
import { createRepoMapDef } from '../knowledge/repoMap.def'
import { openRepoMapDb } from '../knowledge/repoMapCache'
import { callTool, type McpDeps } from '../mcp/mcp.tools'
import { createPolicy } from '../policy/policy.decide'

const NOW = 1_700_000_000_000 // test-only clock

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcw-'))
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('init', '-q')
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() { return 1 }\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

test('git.diff over node MCP: cached until an unstaged edit or a new file', async () => {
  const dir = repo()
  const db = freshDb()
  const board: Workspace[] = [{ id: 'w1', name: 'w', cwd: dir, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }], bridges: [] }]
  let calls = 0
  const deps: McpDeps = {
    policy: createPolicy({ db, workspaces: () => board }), workspaces: () => board,
    central: { db, registry: createRegistry(), env: {} }, browser: null, events: null,
    gitDiff: async () => { calls += 1; return { status: 200, body: { files: [], total: calls } } },
  }
  const diff = async () => (await callTool(deps, 'a1', 'tok', 'git_diff', { root: dir })).outcome
  expect(await diff()).toBe('ok')
  expect(await diff()).toBe('ok')
  expect(calls).toBe(1)
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() { return 2 }\n') // unstaged edit
  await diff()
  expect(calls).toBe(2)
  writeFileSync(join(dir, 'b.ts'), 'x\n') // untracked file
  await diff()
  await diff()
  expect(calls).toBe(3)
})

test('git.diff: an error response is not cached', async () => {
  const dir = repo()
  const db = freshDb()
  const board: Workspace[] = [{ id: 'w1', name: 'w', cwd: dir, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }], bridges: [] }]
  let calls = 0
  const deps: McpDeps = {
    policy: createPolicy({ db, workspaces: () => board }), workspaces: () => board,
    central: { db, registry: createRegistry(), env: {} }, browser: null, events: null,
    gitDiff: async () => { calls += 1; return { status: 500, body: { error: 'boom' } } },
  }
  await callTool(deps, 'a1', 'tok', 'git_diff', { root: dir })
  await callTool(deps, 'a1', 'tok', 'git_diff', { root: dir })
  expect(calls).toBe(2)
})

test('repo.map: a repeat build is served from tool_cache; a commit invalidates it', async () => {
  const dir = repo()
  const db = freshDb()
  db.query('UPDATE project SET path = ? WHERE id = ?').run(dir, 'p1')
  let opens = 0
  const def = createRepoMapDef(() => { opens += 1; return openRepoMapDb(':memory:') })
  const ctx = { db, registry: createRegistry(), guard: ALLOW_ALL_GUARD, maxTier: 'R0' as const, conversationId: 'c', now: () => NOW }
  const first = await def.handler(ctx, { maxTokens: 512 }, 'p1')
  expect(first.ok).toBe(true)
  expect(await def.handler(ctx, { maxTokens: 512 }, 'p1')).toEqual(first)
  expect(opens).toBe(1)
  await def.handler(ctx, { maxTokens: 1024 }, 'p1') // different args, different key
  expect(opens).toBe(2)
  writeFileSync(join(dir, 'c.ts'), 'export const gamma = 1\n')
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'])
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two'])
  const after = await def.handler(ctx, { maxTokens: 512 }, 'p1')
  expect(opens).toBe(3)
  expect(String((after as { data?: { map?: string } }).data?.map)).toContain('c.ts')
})
