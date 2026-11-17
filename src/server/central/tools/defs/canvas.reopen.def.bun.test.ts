import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { BridgeLink, Workspace } from '../../../../shared/workspace'
import type { CanvasAddInput, CanvasNode } from '../../../canvas/canvasPush'
import { ensureSessionHistorySchema, replaceClosed, type HistoryDb } from '../../../sessionHistory.store'
import { CENTRAL_CLOSED_CAP, listCentralClosed } from '../../centralClosed.store'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, Tier, ToolCtx } from '../toolTypes'
import { createCanvasActDefs } from './canvas.act.defs'
import { createCanvasReopenDefs, HUMAN_CLOSE_SLACK_MS } from './canvas.reopen.def'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1): a terminal, a browser cabled to it, and a second terminal.
let board: CanvasNode[]
let bridges: BridgeLink[]
let adds: CanvasAddInput[]
let f: Fixture
let hist: HistoryDb
let unregister = (): void => undefined
let clock = 1_000

const fake = {
  add: (input: CanvasAddInput) => { adds.push(input); board.push(...input.nodes); bridges.push(...(input.bridges ?? [])); return { ok: true as const, updatedAt: 2, nodes: input.nodes } },
  remove: (input: { workspaceId: string; nodeIds: string[] }) => {
    const removed = board.filter((n) => input.nodeIds.includes(n.id))
    board = board.filter((n) => !input.nodeIds.includes(n.id))
    bridges = bridges.filter((b) => !input.nodeIds.includes(b.source) && !input.nodeIds.includes(b.target))
    return { ok: true as const, workspace: { id: input.workspaceId } as Workspace, removed }
  },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); adds = []; clock = 1_000
  board = [
    { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
    { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi' },
    { id: 'n3', kind: 'terminal', x: 0, y: 0, name: 'Plum' },
  ]
  bridges = [{ id: 'b1', source: 'n1', target: 'n2', kind: 'context' }]
  hist = new Database(':memory:') as unknown as HistoryDb
  ensureSessionHistorySchema(hist)
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? ({ id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: board, bridges } as never) : null))
})
afterEach(() => { unregister(); f.close() })

function ctx(maxTier: Tier = 'R2', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }, guard: ControlGuard = ALLOW_ALL_GUARD): ToolCtx {
  const registry = createRegistry()
  createCanvasActDefs({ canvas: () => fake, browserOn: () => true, history: () => hist }).forEach((d) => registry.register(d))
  createCanvasReopenDefs({ canvas: () => fake, history: () => hist }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard, maxTier, conversationId: 'central:global', now: () => clock, env }
}
const close = (ids: string[]) => execTool(ctx(), 'canvas.close', { projectId: 'p1', nodeIds: ids, reason: 'tidy up' })
const reopen = (input: Record<string, unknown> = {}, c = ctx()) => execTool(c, 'canvas.reopen', { projectId: 'p1', ...input })

describe('canvas.reopen', () => {
  it('is R1 behind the read-tools flag', async () => {
    expect(createCanvasReopenDefs({ canvas: () => fake, history: () => hist }).map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.reopen', 'R1', READ_TOOLS_FLAG]])
    expect(await reopen({ node: 'n1' }, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await reopen({ node: 'n1' }, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
  })

  it('canvas.close remembers the node, its name and its cables (before the board drops them)', async () => {
    await close(['n1'])
    const [entry] = listCentralClosed(hist, 'w-p1')
    expect(entry).toMatchObject({ workspaceId: 'w-p1', node: { id: 'n1', name: 'Mango' }, bridges: [{ id: 'b1', source: 'n1', target: 'n2' }] })
  })

  it('reopens a node Central closed by name or id, with its cable, and forgets the record', async () => {
    await close(['n1'])
    expect(board.map((n) => n.id)).toEqual(['n2', 'n3'])
    expect(await reopen({ node: 'mango' })).toMatchObject({ ok: true, data: { count: 1, ids: ['n1'], reopened: [{ id: 'n1', name: 'Mango', kind: 'terminal' }] } })
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ workspaceId: 'w-p1', nodes: [{ id: 'n1' }], bridges: [{ id: 'b1' }] })
    expect(listCentralClosed(hist, 'w-p1')).toEqual([])
    expect(await reopen({ node: 'n1' })).toMatchObject({ ok: false, code: 'not_closed_by_central' })
  })

  it('leaves out a cable whose other end is gone too', async () => {
    await close(['n1', 'n2'])
    await reopen({ node: 'n1' })
    expect(adds[0]!.bridges === undefined).toBe(true)
  })

  it('without a node it only lists what Central closed', async () => {
    await close(['n3'])
    expect(await reopen()).toMatchObject({ ok: true, data: { reopenable: [{ id: 'n3', name: 'Plum' }], count: 0, ids: [] } })
    expect(adds).toEqual([])
  })

  it('never reopens a node the user closed: unknown to Central is refused', async () => {
    board = board.filter((n) => n.id !== 'n3') // the human closed Plum; nothing in central_closed
    const res = await reopen({ node: 'Plum' })
    expect(res).toMatchObject({ ok: false, code: 'not_closed_by_central' })
    expect(adds).toEqual([])
  })

  it('refuses a node the user closed AFTER Central did (reopened by them, closed again)', async () => {
    await close(['n3'])
    board.push({ id: 'n3', kind: 'terminal', x: 0, y: 0, name: 'Plum' }) // the user reopened it ...
    board = board.filter((n) => n.id !== 'n3') // ... and closed it again
    replaceClosed(hist, [{ node: { id: 'n3', kind: 'terminal' } as never, workspaceId: 'w-p1', workspaceName: 'Alpha WS', closedAt: clock + HUMAN_CLOSE_SLACK_MS + 1 }])
    expect(await reopen({ node: 'n3' })).toMatchObject({ ok: false, code: 'closed_by_user' })
    expect(adds).toEqual([])
    expect(listCentralClosed(hist, 'w-p1')).toEqual([])
  })

  it("accepts the client's own record of Central's close (a few ms later) as Central's", async () => {
    await close(['n3'])
    replaceClosed(hist, [{ node: { id: 'n3', kind: 'terminal' } as never, workspaceId: 'w-p1', workspaceName: 'Alpha WS', closedAt: clock + 40 }])
    expect(await reopen({ node: 'n3' })).toMatchObject({ ok: true, data: { ids: ['n3'] } })
  })

  it('says already_open when the user got it back first, and refuses wrong project, bad shape and a denying guard', async () => {
    await close(['n3'])
    board.push({ id: 'n3', kind: 'terminal', x: 0, y: 0 })
    expect(await reopen({ node: 'n3' })).toMatchObject({ ok: false, code: 'already_open' })
    expect(await reopen({ node: 'n3', projectId: 'nope' })).toMatchObject({ ok: false })
    expect(await reopen({ node: 'n3', extra: 1 })).toMatchObject({ ok: false, code: 'invalid_shape' })
    await close(['n2'])
    const denied = ctx('R2', { [READ_TOOLS_FLAG]: 'on' }, { check: () => ({ ok: false, code: 'level_denied' }) })
    expect(await reopen({ node: 'n2' }, denied)).toMatchObject({ ok: false, code: 'level_denied' })
    expect(adds).toEqual([])
  })

  it('keeps at most the cap of records per workspace, newest first', async () => {
    board = Array.from({ length: CENTRAL_CLOSED_CAP + 3 }, (_, i) => ({ id: `x${i}`, kind: 'terminal' as const, x: 0, y: 0 }))
    for (const n of [...board]) { clock += 1; await close([n.id]) }
    const kept = listCentralClosed(hist, 'w-p1')
    expect(kept).toHaveLength(CENTRAL_CLOSED_CAP)
    expect(kept[0]!.node.id).toBe(`x${CENTRAL_CLOSED_CAP + 2}`)
  })
})
