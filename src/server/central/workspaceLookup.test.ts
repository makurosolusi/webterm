// Canvas workspaces (webterm.db) are the source of truth for Central projects: the ledger only
// holds p1..p3 (seed), the canvas holds w-p1 + two workspaces that never had a Central turn.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allRows } from '../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from './centralTestFixture.testutil'
import { buildStateHeader } from './context/contextHeader'
import { ALLOW_ALL_GUARD, execTool } from './tools/toolExec'
import { createRegistry } from './tools/toolRegistry'
import type { ToolCtx } from './tools/toolTypes'
import { PROJECT_READ_DEFS } from './tools/defs/read.project'
import { READ_TOOLS_FLAG } from './tools/defs/read.shared'
import { registerWorkspaceLookup, syncWorkspaceProjects, type WorkspaceRecord } from './workspaceLookup'

let f: Fixture
let unregister: () => void
let workspaces: WorkspaceRecord[]

beforeEach(() => {
  f = openFixture()
  seedPortfolio(f.db) // ledger: p1 (w-p1), p2 (w-p2), p3 (w-p3)
  workspaces = [ // test-only: w-p2/w-p3 were deleted from the canvas
    { id: 'w-p1', name: 'laya-api', cwd: '/tmp/laya' },
    { id: 'ws-wibu', name: 'wibu', cwd: '/tmp/wibu' },
    { id: 'ws-noc', name: 'noc' },
  ]
  unregister = registerWorkspaceLookup((id) => workspaces.find((w) => w.id === id) ?? null, () => workspaces)
})
afterEach(() => { unregister(); f.close() })

function ctx(conversationId = 'central:global'): ToolCtx {
  const registry = createRegistry()
  PROJECT_READ_DEFS.forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId, now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}

type Listed = { total: number; boundProjectId: string | null; projects: Array<Record<string, unknown>> }

describe('project.list over canvas workspaces', () => {
  it('lists every live workspace with merged ledger stats and hides deleted ones', async () => {
    const res = await execTool(ctx('central:project:p1'), 'project.list', {})
    expect(res.ok).toBe(true)
    const data = res.data as Listed
    expect(data.total).toBe(3)
    expect(data.boundProjectId).toBe('p1')
    const byId = Object.fromEntries(data.projects.map((p) => [p.id, p]))
    expect(Object.keys(byId).sort()).toEqual(['p1', 'ws-noc', 'ws-wibu'])
    expect(byId['p1']).toMatchObject({ name: 'laya-api', tasks: 5, pendingApprovals: 1, pendingPlanItems: 1 })
    expect(byId['ws-wibu']).toMatchObject({ name: 'wibu', status: 'active', tasks: 0, pendingApprovals: 0, pendingPlanItems: 0 })
    expect(byId['ws-noc']).toMatchObject({ name: 'noc' })
  })

  it('paginates and rejects an out-of-range limit', async () => {
    const page = (await execTool(ctx(), 'project.list', { limit: 2, offset: 2 })).data as Listed
    expect(page.total).toBe(3)
    expect(page.projects).toHaveLength(1)
    expect(await execTool(ctx(), 'project.list', { limit: 0 })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })
})

describe('syncWorkspaceProjects', () => {
  it('is idempotent: one ledger row per workspace, renames copied, nothing deleted', () => {
    syncWorkspaceProjects(f.db, () => 7)
    syncWorkspaceProjects(f.db, () => 7)
    const rows = allRows(f.db, 'SELECT id, workspace_id, name FROM project ORDER BY id')
    expect(rows).toEqual([
      { id: 'p1', workspace_id: 'w-p1', name: 'laya-api' },
      { id: 'p2', workspace_id: 'w-p2', name: 'Beta' },
      { id: 'p3', workspace_id: 'w-p3', name: 'Gamma' },
      { id: 'ws-noc', workspace_id: 'ws-noc', name: 'noc' },
      { id: 'ws-wibu', workspace_id: 'ws-wibu', name: 'wibu' },
    ])
  })

  it('returns null without a registered store (ledger-only callers)', () => {
    unregister()
    expect(syncWorkspaceProjects(f.db)).toBeNull()
  })
})

describe('state header in a bound project chat', () => {
  it('counts all canvas projects, not only the bound one', () => {
    const header = JSON.parse(buildStateHeader(f.db, 'central:project:p1').slice('State: '.length)) as
      { projectTotal: number; projects: Array<{ name: string }>; scope: string }
    expect(header.projectTotal).toBe(3)
    expect(header.projects.map((p) => p.name).sort()).toEqual(['laya-api', 'noc', 'wibu'])
    expect(header.scope).toBe('p1')
  })
})
