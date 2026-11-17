import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { USER_ACTIVE_PAUSE_MS } from '../../../../shared/canvasCamera'
import type { ServerMsg } from '../../../../shared/protocol'
import type { Workspace } from '../../../../shared/workspace'
import type { AppendEventInput } from '../../../events/eventModel'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'
import { createWorkspaceColorDefs } from './workspace.color.def'

// test-only boards: p1 -> w-p1 (seeded by seedPortfolio), p2 -> w-p2.
const board = (id: string, name: string, color: string, colorShade = 'default'): Workspace =>
  ({ id, name, color, colorShade, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 1 })

let f: Fixture
let boards: Workspace[]
let frames: ServerMsg[]
let records: AppendEventInput[]
let idle: number | null
const undo: Array<() => void> = []
const db = {
  get: (id: string) => boards.find((w) => w.id === id) ?? null,
  list: () => boards,
  usedHues: () => boards.flatMap((w) => (w.color ? [w.color] : [])),
  setColor: (id: string, color: string, shade: string) => {
    const w = boards.find((x) => x.id === id)
    if (!w) return false
    w.color = color; w.colorShade = shade
    return true
  },
}
const deps = { runtime: () => ({ db, broadcast: (m: ServerMsg) => { frames.push(m) } }), idleMs: () => idle, record: (e: AppendEventInput) => { records.push(e) } }

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); frames = []; records = []; idle = Infinity
  boards = [board('w-p1', 'Alpha WS', 'red', 'soft'), board('w-p2', 'Beta WS', 'teal')]
  undo.push(registerWorkspaceLookup((id) => boards.find((w) => w.id === id) ?? null, () => boards))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close() })

function ctx(maxTier: Tier = 'R1', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createWorkspaceColorDefs(deps).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const color = (input: Record<string, unknown> = {}, c = ctx()) => execTool(c, 'workspace.color', { projectId: 'p1', ...input })

describe('workspace.color', () => {
  it('is R1 behind the read-tools flag', async () => {
    expect(createWorkspaceColorDefs(deps).map((d) => [d.name, d.tier, d.flag])).toEqual([['workspace.color', 'R1', READ_TOOLS_FLAG]])
    expect(await color({}, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await color({}, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
  })

  it('reads the workspace color and the others without changing anything', async () => {
    const r = await color()
    expect(r).toMatchObject({ ok: true, data: { workspaceId: 'w-p1', name: 'Alpha WS', color: 'red', shade: 'soft', others: [{ name: 'Beta WS', color: 'teal' }] } })
    expect(frames).toEqual([])
    expect(records).toEqual([])
  })

  it('changes color and shade, announces it as Central with the previous color, and records a bounded act', async () => {
    const r = await color({ color: 'blue', shade: 'vivid' })
    expect(r).toMatchObject({ ok: true, data: { applied: true, color: 'blue', shade: 'vivid', previous: 'red soft' } })
    expect(boards[0]).toMatchObject({ color: 'blue', colorShade: 'vivid' })
    expect(frames).toEqual([{ t: 'workspaceColor', workspaceId: 'w-p1', color: 'blue', shade: 'vivid', by: 'central', name: 'Alpha WS', previous: { color: 'red', shade: 'soft' } }])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'central.act', actor: 'central', subject: 'workspace:w-p1', payload: { tool: 'workspace.color', verb: 'recolored', color: 'blue', shade: 'vivid' } })
  })

  it('keeps the other half when only one of color/shade is given', async () => {
    await color({ shade: 'vivid' })
    expect(boards[0]).toMatchObject({ color: 'red', colorShade: 'vivid' })
  })

  it('yields to a user who moved the canvas lately, and changes nothing', async () => {
    idle = USER_ACTIVE_PAUSE_MS - 1
    expect(await color({ color: 'blue' })).toMatchObject({ ok: true, data: { applied: false, reason: 'user_active' } })
    expect(boards[0].color).toBe('red')
    expect(frames).toEqual([])
    expect(records).toEqual([])
    idle = USER_ACTIVE_PAUSE_MS
    expect(await color({ color: 'blue' })).toMatchObject({ ok: true, data: { applied: true } })
  })

  it('refuses a color outside the palette or an unknown key', async () => {
    expect(await color({ color: '#ff0000' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await color({ shade: 'neon' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await color({ extra: 1 })).toMatchObject({ ok: false })
    expect(boards[0].color).toBe('red')
  })
})
