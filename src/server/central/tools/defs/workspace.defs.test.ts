import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '../../../../shared/protocol'
import type { Workspace } from '../../../../shared/workspace'
import { getRow } from '../../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'
import { createWorkspaceDefs, WORKSPACE_NAME_MAX, type WorkspaceRuntime } from './workspace.defs'

// test-only: an in-memory store with Db.save's version check; p1 -> w-p1, p2 -> w-p2 (seedPortfolio).
const board = (id: string, name: string, updatedAt: number): Workspace =>
  ({ id, name, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt })

let f: Fixture
let dir: string
let boards: Map<string, Workspace>
let frames: ServerMsg[]
let raceLeft: number // saves that lose to a "UI" write first
const undo: Array<() => void> = []

const rt: WorkspaceRuntime = {
  async create({ name, cwd, color }) {
    let isDir = false
    try { isDir = statSync(cwd).isDirectory() } catch { isDir = false } // absent = not a directory, as createFields
    if (!isDir) return { ok: false, bad: 'cwd' }
    const ws = { ...board(`w-new${boards.size}`, name, 1), cwd, ...(color ? { color } : {}) }
    boards.set(ws.id, ws)
    return { ok: true, workspace: ws }
  },
  db: {
    get: (id) => boards.get(id) ?? null,
    save(ws, base) {
      const cur = boards.get(ws.id)
      if (!cur) return 'missing'
      if (raceLeft > 0) { raceLeft--; boards.set(cur.id, { ...cur, updatedAt: cur.updatedAt + 1 }); return 'stale' }
      if (base !== undefined && cur.updatedAt > base) return 'stale'
      boards.set(ws.id, { ...ws, updatedAt: cur.updatedAt + 1 })
      return 'saved'
    },
  },
  broadcast: (msg) => { frames.push(msg) },
  dataDir: () => join(dir, 'data'),
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); frames = []; raceLeft = 0
  dir = mkdtempSync(join(tmpdir(), 'wsdefs-'))
  boards = new Map([['w-p1', board('w-p1', 'Alpha', 10)], ['w-p2', board('w-p2', 'Beta', 20)]])
  undo.push(registerWorkspaceLookup((id) => boards.get(id) ?? null, () => [...boards.values()]))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close(); rmSync(dir, { recursive: true, force: true }) })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createWorkspaceDefs({ runtime: () => rt }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const create = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'workspace.create', input)
const rename = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'workspace.rename', input)
const projectName = (id: string) => getRow(f.db, 'SELECT name FROM project WHERE id = ?', id)?.['name']

describe('workspace defs', () => {
  it('declares create at R2 (not project-scoped) and rename at R1, behind the read-tools flag', async () => {
    expect(createWorkspaceDefs({ runtime: () => rt }).map((d) => [d.name, d.tier, d.flag, d.projectScoped])).toEqual([
      ['workspace.create', 'R2', READ_TOOLS_FLAG, false], ['workspace.rename', 'R1', READ_TOOLS_FLAG, undefined],
    ])
    expect(await create({ name: 'X', cwd: dir }, ctx('R1'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await rename({ projectId: 'p1', name: 'X' }, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await rename({ projectId: 'p1', name: 'X' }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(frames).toEqual([])
  })
})

describe('workspace.create', () => {
  it('creates the board, makes its project row at once and tells every window to list it', async () => {
    const res = await create({ name: '  Gamma  ', cwd: dir, color: 'teal' })
    expect(res).toMatchObject({ ok: true, data: { workspaceId: 'w-new2', projectId: 'w-new2', name: 'Gamma', cwd: dir } })
    expect(boards.get('w-new2')).toMatchObject({ name: 'Gamma', cwd: dir, color: 'teal' })
    expect(projectName('w-new2')).toBe('Gamma')
    expect(frames).toEqual([{ t: 'workspaces' }])
    // The returned projectId is usable by a project-scoped tool right away.
    expect(await rename({ projectId: 'w-new2', name: 'Gamma 2' })).toMatchObject({ ok: true, data: { previous: 'Gamma' } })
  })

  it('refuses a bad name, a relative / missing / non-directory cwd and the data dir, creating nothing', async () => {
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    expect(await create({ name: '   ', cwd: dir })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(await create({ name: 'a\nb', cwd: dir })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(await create({ name: 'x'.repeat(WORKSPACE_NAME_MAX + 1), cwd: dir })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await create({ name: 'A', cwd: 'rel/dir' })).toMatchObject({ ok: false, code: 'cwd_not_absolute' })
    expect(await create({ name: 'A', cwd: join(dir, 'ghost') })).toMatchObject({ ok: false, code: 'cwd_not_found' })
    expect(await create({ name: 'A', cwd: file })).toMatchObject({ ok: false, code: 'cwd_not_directory' })
    expect(await create({ name: 'A', cwd: join(dir, 'data', 'sub') })).toMatchObject({ ok: false, code: 'cwd_forbidden' })
    expect(await create({ name: 'A', cwd: dir, projectId: 'p1' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await create({ name: 'A' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(boards.size).toBe(2)
    expect(frames).toEqual([])
  })
})

describe('workspace.rename', () => {
  it('saves the new name on the stored version, pushes a versioned canvas frame and syncs the project row', async () => {
    expect(await rename({ projectId: 'p1', name: ' Alpha Prime ' })).toMatchObject({ ok: true, data: { workspaceId: 'w-p1', name: 'Alpha Prime', previous: 'Alpha' } })
    expect(boards.get('w-p1')).toMatchObject({ name: 'Alpha Prime', updatedAt: 11 })
    expect(frames).toEqual([{ t: 'canvas', workspaceId: 'w-p1', base: 10, updatedAt: 11, nodes: [], bridges: [], name: 'Alpha Prime' }])
    expect(projectName('p1')).toBe('Alpha Prime')
  })

  it('the same name is a no-op: no save, no frame', async () => {
    expect(await rename({ projectId: 'p2', name: 'Beta' })).toMatchObject({ ok: true, data: { name: 'Beta', previous: 'Beta' } })
    expect(boards.get('w-p2')?.updatedAt).toBe(20)
    expect(frames).toEqual([])
  })

  it('retries a lost save race on the re-read board, and gives up after five', async () => {
    raceLeft = 2
    expect(await rename({ projectId: 'p1', name: 'Raced' })).toMatchObject({ ok: true })
    expect(frames).toEqual([expect.objectContaining({ base: 12, updatedAt: 13, name: 'Raced' })])
    raceLeft = 5
    expect(await rename({ projectId: 'p2', name: 'Never' })).toMatchObject({ ok: false, code: 'invalid_proposal' }) // execTool turns the throw into a refusal
    expect(boards.get('w-p2')?.name).toBe('Beta')
    expect(frames).toHaveLength(1)
  })

  it('refuses a bad name, an unknown project and a deleted board without a frame', async () => {
    expect(await rename({ projectId: 'p1', name: '\u0007' })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(await rename({ projectId: 'nope', name: 'X' })).toMatchObject({ ok: false, code: 'project_not_found' })
    expect(await rename({ projectId: 'p3', name: 'X' })).toMatchObject({ ok: false, code: 'workspace_not_found' }) // w-p3 never stored
    expect(await rename({ projectId: 'p1', name: 'X', color: 'red' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(frames).toEqual([])
  })
})
