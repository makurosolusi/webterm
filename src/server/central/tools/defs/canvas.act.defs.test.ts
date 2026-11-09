import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasAddInput, CanvasNode } from '../../../canvas/canvasPush'
import type { Workspace } from '../../../../shared/workspace'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx, Tier } from '../toolTypes'
import { createCanvasActDefs, type NodeCanvas } from './canvas.act.defs'
import { READ_TOOLS_FLAG } from './read.shared'
import { resolveClaudeLaunch } from '../../../claudeLauncher/claudeLauncher'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango', title: 'shell', cwd: '/srv/alpha' },
  { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi 2', url: 'https://example.com/' },
  { id: 'c-ag1', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
  { id: 'c-ag2', kind: 'agent', x: 0, y: 0, agentId: 'claude' },
]

let f: Fixture
let unregister = (): void => undefined
let adds: CanvasAddInput[]
let removes: Array<{ workspaceId: string; nodeIds: string[] }>
const fake: NodeCanvas = {
  add: (input) => { adds.push(input); return { ok: true, updatedAt: 2, nodes: input.nodes } },
  remove: (input) => {
    removes.push(input)
    return { ok: true, workspace: { id: input.workspaceId } as Workspace, removed: BOARD.filter((n) => input.nodeIds.includes(n.id)) }
  },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); adds = []; removes = []
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
  // ag1 is a live worker; ag2 has ended (its node is an ordinary leftover).
  f.db.exec(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES
    ('ag1', 'p1', 'claude', 'pty', 'working', 'central:global', 1), ('ag2', 'p1', 'claude', 'pty', 'closed', 'central:global', 1)`)
})
afterEach(() => { unregister(); f.close() })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasActDefs({ canvas: () => fake, browserOn: () => true }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const close = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.close', { projectId: 'p1', reason: 'tidy up', ...input })
const open = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.open', { projectId: 'p1', ...input })

describe('canvas.open / canvas.close defs', () => {
  it('declares close at R2 (approval card via the guard ladder) and open at R1, both behind the read-tools flag', async () => {
    const defs = createCanvasActDefs({ canvas: () => fake, browserOn: () => true })
    expect(defs.map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.open', 'R1', READ_TOOLS_FLAG], ['canvas.close', 'R2', READ_TOOLS_FLAG]])
    expect(await close({ nodeIds: ['n1'] }, ctx('R1'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await open({ kind: 'terminal' }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(await close({ nodeIds: ['n1'] }, ctx('R2', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(removes.length + adds.length).toBe(0)
  })
})

describe('canvas.close', () => {
  it('rejects malformed input before touching the board', async () => {
    const bad = [
      { nodeIds: [] }, { nodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) }, { nodeIds: ['a b'] }, { nodeIds: 'n1' },
      { nodeIds: ['n1'], reason: '' }, { nodeIds: ['n1'], reason: 'x'.repeat(201) }, { nodeIds: ['n1'], reason: 'bell\x07' },
      { nodeIds: ['n1'], extra: 1 },
    ]
    for (const input of bad) expect(await close(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(ctx(), 'canvas.close', { projectId: 'p1', nodeIds: ['n1'] })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(removes).toEqual([])
  })

  it('refuses the whole call when any id is not on the board, naming the unknown ones', async () => {
    const res = await close({ nodeIds: ['n1', 'ghost', 'n2', 'gone'] })
    expect(res).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['ghost', 'gone'] } })
    expect(removes).toEqual([])
  })

  it('sends live Central workers to agent.close but lets ended ones close', async () => {
    const res = await close({ nodeIds: ['n1', 'c-ag1'] })
    expect(res).toMatchObject({ ok: false, code: 'use_agent_close', data: { nodeIds: ['c-ag1'], hint: expect.stringContaining('agent.close') } })
    expect(removes).toEqual([])
    expect(await close({ nodeIds: ['c-ag2'] })).toMatchObject({ ok: true, data: { count: 1 } })
  })

  it('removes the de-duplicated ids from the project workspace and reports id/kind/title', async () => {
    const res = await close({ nodeIds: ['n1', 'n2', 'n1'] })
    expect(removes).toEqual([{ workspaceId: 'w-p1', nodeIds: ['n1', 'n2'] }])
    expect(res).toMatchObject({ ok: true, data: { count: 2, ids: ['n1', 'n2'], closed: [{ id: 'n1', kind: 'terminal', title: 'shell' }, { id: 'n2', kind: 'browser', title: null }] } })
    expect(JSON.stringify(res)).not.toContain('/srv/alpha')
  })

  it('accepts node names (case-insensitive) next to ids, resolves them to ids, and reports the names', async () => {
    const res = await close({ nodeIds: ['mango', 'KIWI 2', 'n1'] })
    expect(removes).toEqual([{ workspaceId: 'w-p1', nodeIds: ['n1', 'n2'] }])
    expect(res).toMatchObject({ ok: true, data: { ids: ['n1', 'n2'], closed: [{ id: 'n1', name: 'Mango' }, { id: 'n2', name: 'Kiwi 2' }] } })
  })

  it('a name that matches no node refuses the whole call like an unknown id', async () => {
    expect(await close({ nodeIds: ['Mango', 'Otter'] })).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['Otter'] } })
    expect(removes).toEqual([])
  })

  it('passes a board write failure through as its code', async () => {
    const c = ctx()
    c.registry = createRegistry()
    createCanvasActDefs({ canvas: () => ({ ...fake, remove: () => ({ ok: false, code: 'node_not_found' }) }), browserOn: () => true }).forEach((d) => c.registry.register(d))
    expect(await close({ nodeIds: ['n1'] }, c)).toMatchObject({ ok: false, code: 'node_not_found' })
  })
})

describe('canvas.open', () => {
  it('rejects malformed input, model-supplied cwd/cmd and non-http urls', async () => {
    const bad = [
      { kind: 'shell' }, { kind: 'terminal', count: 0 }, { kind: 'terminal', count: 6 }, { kind: 'claude', count: 1.5 },
      { kind: 'browser', count: 2 }, { kind: 'terminal', url: 'https://example.com' }, { kind: 'browser', url: 'javascript:alert(1)' },
      { kind: 'browser', url: 'file:///etc/passwd' }, { kind: 'browser', url: 'https://u:p@example.com' }, { kind: 'browser', url: 'example.com' },
      { kind: 'terminal', title: 't'.repeat(81) }, { kind: 'terminal', title: 'a\x1bb' }, { kind: 'terminal', extra: true },
    ]
    for (const input of bad) expect(await open(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await open({ kind: 'terminal', cwd: '/etc' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(await open({ kind: 'claude', cmd: 'rm -rf /' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(adds).toEqual([])
  })

  it('opens N terminals in the project directory with no anchor', async () => {
    const res = await open({ kind: 'terminal', count: 3, title: 'build' })
    expect(adds).toHaveLength(1)
    const [call] = adds
    expect(call!.workspaceId).toBe('w-p1')
    expect(call!.anchorNodeId).toBeUndefined()
    expect(call!.nodes.map((n) => [n.kind, n.cwd, n.title])).toEqual(Array(3).fill(['terminal', '/srv/alpha', 'build']))
    expect(new Set(call!.nodes.map((n) => n.id)).size).toBe(3)
    expect(res).toMatchObject({ ok: true, data: { count: 3, kind: 'terminal', opened: call!.nodes.map((n) => ({ id: n.id, kind: 'terminal' })) } })
  })

  it('lists the opened nodes with the names the saved board gave them', async () => {
    const c = ctx()
    c.registry = createRegistry()
    const naming: NodeCanvas = { ...fake, add: (input) => ({ ok: true, updatedAt: 2, nodes: input.nodes.map((n, i) => ({ ...n, name: ['Otter', 'Fern'][i] })) }) }
    createCanvasActDefs({ canvas: () => naming, browserOn: () => true }).forEach((d) => c.registry.register(d))
    const res = await open({ kind: 'terminal', count: 2 }, c)
    expect(res).toMatchObject({ ok: true, data: { opened: [{ name: 'Otter', kind: 'terminal' }, { name: 'Fern', kind: 'terminal' }] } })
  })

  it('opens a builtin claude node with a recorded launch profile and no pre-minted session', async () => {
    await open({ kind: 'claude' })
    const node = adds[0]!.nodes[0]!
    expect(node).toMatchObject({ kind: 'agent', agentId: 'claude', cwd: '/srv/alpha', cmd: expect.stringContaining('claude'), claudeProfileId: expect.any(String) })
    expect(node.sessionId).toBeUndefined()
  })

  it('opens N Agent Chat nodes like the board does, with the resolved default launch profile', async () => {
    const res = await open({ kind: 'chat', count: 2 })
    await open({ kind: 'chat', title: 'review' })
    const [two, one] = adds
    const chat = { kind: 'agentChat', agentId: 'claude', cwd: '/srv/alpha', claudeProfileId: resolveClaudeLaunch().profile.id }
    expect(two!.nodes).toEqual([expect.objectContaining({ ...chat, title: 'Agent Chat' }), expect.objectContaining({ ...chat, title: 'Agent Chat' })])
    expect(one!.nodes[0]).toMatchObject({ ...chat, title: 'review' })
    for (const n of [...two!.nodes, ...one!.nodes]) expect([n.chatSessionId, n.sessionId, n.cmd]).toEqual([undefined, undefined, undefined])
    expect(res).toMatchObject({ ok: true, data: { count: 2, kind: 'chat', opened: [{ kind: 'agentChat' }, { kind: 'agentChat' }] } })
  })

  it('refuses a chat with a url, a path or a count out of range', async () => {
    for (const bad of [{ url: 'https://example.com' }, { path: 'src' }, { count: 0 }, { count: 6 }]) {
      expect(await open({ kind: 'chat', ...bad })).toMatchObject({ ok: false, code: 'invalid_shape' })
    }
    expect(adds).toEqual([])
  })

  it('opens a browser at the normalized url (page start applies the nav guard) or blank', async () => {
    await open({ kind: 'browser', url: '  https://GitHub.com/org  ' })
    await open({ kind: 'browser' })
    expect(adds.map((a) => a.nodes[0])).toEqual([
      { id: expect.any(String), kind: 'browser', x: 0, y: 0, width: 640, height: 400, url: 'https://github.com/org' },
      { id: expect.any(String), kind: 'browser', x: 0, y: 0, width: 640, height: 400 },
    ])
  })

  it('refuses a browser while the browser feature is off in Settings, but still opens terminals', async () => {
    const c = ctx()
    c.registry = createRegistry()
    createCanvasActDefs({ canvas: () => fake, browserOn: () => false }).forEach((d) => c.registry.register(d))
    expect(await open({ kind: 'browser', url: 'https://example.com' }, c)).toMatchObject({ ok: false, code: 'browser_disabled', data: { hint: expect.stringContaining('Settings') } })
    expect(adds).toEqual([])
    expect(await open({ kind: 'terminal' }, c)).toMatchObject({ ok: true, data: { count: 1, kind: 'terminal' } })
    expect(adds).toHaveLength(1)
  })

  it('reports a project without a workspace and never calls add', async () => {
    expect(await execTool(ctx(), 'canvas.open', { projectId: 'p2', kind: 'terminal' })).toMatchObject({ ok: false, code: 'workspace_not_found' })
    expect(adds).toEqual([])
  })
})

describe('canvas.open files / editor / diff', () => {
  // test-only tree: <tmp>/proj is the workspace cwd; <tmp>/outside is not.
  let tmp: string
  let proj: string
  let cwd: string | undefined
  const editorOn = (path: string): CanvasNode => ({ id: 'e1', kind: 'editor', x: 0, y: 0, name: 'Fern', filePath: path })
  let board: CanvasNode[]
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'canvas-open-'))
    proj = join(tmp, 'proj')
    mkdirSync(join(proj, 'src', 'lib'), { recursive: true })
    mkdirSync(join(tmp, 'outside'))
    writeFileSync(join(proj, 'src', 'app.ts'), 'x')
    writeFileSync(join(tmp, 'outside', 'secret.txt'), 's')
    symlinkSync(join(tmp, 'outside'), join(proj, 'out'))
    symlinkSync(join(proj, 'src', 'app.ts'), join(proj, 'app-link.ts'))
    cwd = proj
    board = []
    registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd, nodes: board } : null))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('opens a file explorer on the project directory by default, or on a folder inside it', async () => {
    await open({ kind: 'files' })
    await open({ kind: 'files', path: 'src/lib' })
    await open({ kind: 'files', path: join(proj, 'src') })
    expect(adds.map((a) => a.nodes[0])).toEqual([
      { id: expect.any(String), kind: 'files', x: 0, y: 0, dirPath: proj },
      { id: expect.any(String), kind: 'files', x: 0, y: 0, dirPath: join(proj, 'src', 'lib') },
      { id: expect.any(String), kind: 'files', x: 0, y: 0, dirPath: join(proj, 'src') },
    ])
  })

  it('opens a file in an editor node sized and titled like the client, path kept as cwd + relative', async () => {
    const res = await open({ kind: 'editor', path: './src/app.ts' })
    expect(adds[0]!.nodes).toEqual([{ id: expect.any(String), kind: 'editor', x: 0, y: 0, title: 'app.ts', filePath: join(proj, 'src', 'app.ts'), width: 660, height: 460 }])
    expect(res).toMatchObject({ ok: true, data: { count: 1, kind: 'editor' } })
    await open({ kind: 'editor', path: 'app-link.ts', title: 'entry' }) // a symlink that stays inside is fine
    expect(adds[1]!.nodes[0]).toMatchObject({ title: 'entry', filePath: join(proj, 'app-link.ts') })
  })

  it('reuses an editor already holding the file instead of opening a second one', async () => {
    board = [editorOn(join(proj, 'src', 'app.ts'))]
    expect(await open({ kind: 'editor', path: 'src/app.ts' })).toMatchObject({ ok: true, data: { ids: ['e1'], opened: [{ id: 'e1', name: 'Fern', kind: 'editor' }], alreadyOpen: true } })
    expect(adds).toEqual([])
  })

  it('opens a diff node on the project directory, titled like the client', async () => {
    await open({ kind: 'diff' })
    expect(adds[0]!.nodes).toEqual([{ id: expect.any(String), kind: 'diff', x: 0, y: 0, cwd: proj, title: 'Changes' }])
  })

  it('refuses paths that leave the project, lexically or through a symlink', async () => {
    for (const path of ['../outside/secret.txt', 'src/../../outside/secret.txt', join(tmp, 'outside', 'secret.txt'), 'out/secret.txt', '../nope.ts']) {
      expect(await open({ kind: 'editor', path })).toMatchObject({ ok: false, code: 'path_outside_project' })
    }
    expect(await open({ kind: 'files', path: 'out' })).toMatchObject({ ok: false, code: 'path_outside_project' })
    expect(adds).toEqual([])
  })

  it('reports a missing path and a file/folder mix-up', async () => {
    expect(await open({ kind: 'editor', path: 'src/nope.ts' })).toMatchObject({ ok: false, code: 'path_not_found' })
    expect(await open({ kind: 'editor', path: 'src' })).toMatchObject({ ok: false, code: 'path_wrong_type' })
    expect(await open({ kind: 'files', path: 'src/app.ts' })).toMatchObject({ ok: false, code: 'path_wrong_type' })
    expect(adds).toEqual([])
  })

  it('refuses these kinds when the project has no directory', async () => {
    cwd = undefined
    for (const input of [{ kind: 'files' }, { kind: 'editor', path: 'a.ts' }, { kind: 'diff' }]) {
      expect(await open(input)).toMatchObject({ ok: false, code: 'no_project_dir' })
    }
    expect(adds).toEqual([])
  })

  it('rejects path where it does not apply, an editor without one, and counts on these kinds', async () => {
    const bad = [
      { kind: 'terminal', path: 'src' }, { kind: 'claude', path: 'src' }, { kind: 'browser', path: 'src' }, { kind: 'diff', path: 'src' },
      { kind: 'editor' }, { kind: 'editor', path: '' }, { kind: 'editor', path: 'a\x00b' }, { kind: 'files', path: 'p'.repeat(1025) },
      { kind: 'files', count: 2 }, { kind: 'editor', path: 'src/app.ts', count: 1 }, { kind: 'diff', count: 2 },
      { kind: 'files', url: 'https://example.com' },
    ]
    for (const input of bad) expect(await open(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    // `path` is allowed here, other forbidden keys still are not.
    expect(await open({ kind: 'files', path: 'src', cwd: '/etc' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(adds).toEqual([])
  })
})
