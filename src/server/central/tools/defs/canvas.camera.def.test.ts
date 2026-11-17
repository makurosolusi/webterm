import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, CAMERA_PAN_MAX_PX, USER_ACTIVE_PAUSE_MS } from '../../../../shared/canvasCamera'
import type { ServerMsg } from '../../../../shared/protocol'
import { registerActiveWorkspace } from '../../context/contextHeader'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, Tier, ToolCtx } from '../toolTypes'
import { createCanvasCameraDefs } from './canvas.camera.def'
import { READ_TOOLS_FLAG } from './read.shared'
import { createWorkspaceSwitchDefs } from './workspace.switch.def'

// test-only boards: p1 -> w-p1 (seeded by seedPortfolio), p2 -> w-p2.
const WORKSPACES: WorkspaceRecord[] = [
  { id: 'w-p1', name: 'Alpha WS', nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' }, { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi 2' }] },
  { id: 'w-p2', name: 'Beta WS', nodes: [{ id: 'b1', kind: 'terminal', x: 0, y: 0 }] },
]

let f: Fixture
let active: string | null
let frames: ServerMsg[]
let idle: number | null
const undo: Array<() => void> = []
const ui = { setActive: (id: string) => { active = id }, broadcast: (msg: ServerMsg) => { frames.push(msg) } }
const deps = { ui: () => ui, idleMs: () => idle }

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); active = 'w-p1'; frames = []; idle = Infinity
  undo.push(registerWorkspaceLookup((id) => WORKSPACES.find((w) => w.id === id) ?? null))
  undo.push(registerActiveWorkspace(() => active))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close() })

function ctx(maxTier: Tier = 'R1', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }, guard: ControlGuard = ALLOW_ALL_GUARD): ToolCtx {
  const registry = createRegistry();
  [...createCanvasCameraDefs(deps), ...createWorkspaceSwitchDefs(deps)].forEach((d) => registry.register(d))
  return { db: f.db, registry, guard, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const cam = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.camera', { projectId: 'p1', ...input })
const sw = (input: Record<string, unknown> = {}, c = ctx()) => execTool(c, 'workspace.switch', { projectId: 'p2', ...input })

describe('canvas.camera', () => {
  it('is R1 behind the read-tools flag and the guard still decides', async () => {
    expect(createCanvasCameraDefs(deps).map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.camera', 'R1', READ_TOOLS_FLAG]])
    expect(await cam({ action: 'fit' }, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await cam({ action: 'fit' }, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    const denied = ctx('R1', { [READ_TOOLS_FLAG]: 'on' }, { check: () => ({ ok: false, code: 'level_denied' }) })
    expect(await cam({ action: 'fit' }, denied)).toMatchObject({ ok: false, code: 'level_denied' })
    expect(frames).toEqual([])
  })

  it('fit, focus, zoom and pan send one polite view frame each', async () => {
    expect(await cam({ action: 'fit' })).toMatchObject({ ok: true, data: { applied: true, action: 'fit', workspaceId: 'w-p1' } })
    expect(await cam({ action: 'focus', node: 'kiwi 2' })).toMatchObject({ ok: true, data: { applied: true, nodeId: 'n2' } })
    expect(await cam({ action: 'zoom', zoom: 0.5 })).toMatchObject({ ok: true, data: { applied: true, zoom: 0.5 } })
    expect(await cam({ action: 'pan', dx: 120, dy: -40 })).toMatchObject({ ok: true, data: { applied: true, dx: 120, dy: -40 } })
    expect(frames).toEqual([
      { t: 'view', workspaceId: 'w-p1', polite: true, fit: true },
      { t: 'view', workspaceId: 'w-p1', polite: true, nodeId: 'n2' },
      { t: 'view', workspaceId: 'w-p1', polite: true, zoom: 0.5 },
      { t: 'view', workspaceId: 'w-p1', polite: true, pan: { dx: 120, dy: -40 } },
    ])
  })

  it('clamps zoom and pan to the canvas limits and says so', async () => {
    expect(await cam({ action: 'zoom', zoom: 50 })).toMatchObject({ ok: true, data: { zoom: CAMERA_MAX_ZOOM, clamped: true } })
    expect(await cam({ action: 'zoom', zoom: -3 })).toMatchObject({ ok: true, data: { zoom: CAMERA_MIN_ZOOM, clamped: true } })
    expect(await cam({ action: 'pan', dx: 99999, dy: -99999 })).toMatchObject({ ok: true, data: { dx: CAMERA_PAN_MAX_PX, dy: -CAMERA_PAN_MAX_PX, clamped: true } })
    expect(await cam({ action: 'pan', dx: 10 })).toMatchObject({ ok: true, data: { dx: 10, dy: 0 } })
    expect(frames[0]).toMatchObject({ zoom: CAMERA_MAX_ZOOM })
    expect(frames[2]).toMatchObject({ pan: { dx: CAMERA_PAN_MAX_PX, dy: -CAMERA_PAN_MAX_PX } })
  })

  it('yields to the human: user_active inside the pause window, free right after it', async () => {
    idle = USER_ACTIVE_PAUSE_MS - 1
    expect(await cam({ action: 'fit' })).toMatchObject({ ok: true, data: { applied: false, reason: 'user_active' } })
    expect(frames).toEqual([])
    idle = USER_ACTIVE_PAUSE_MS
    expect(await cam({ action: 'fit' })).toMatchObject({ ok: true, data: { applied: true } })
    idle = null
    expect(await cam({ action: 'fit' })).toMatchObject({ ok: true, data: { applied: false, reason: 'no_visible_window' } })
    expect(frames).toHaveLength(1)
  })

  it('does not move a canvas the user is not viewing', async () => {
    active = 'w-p2'
    expect(await cam({ action: 'fit' })).toMatchObject({ ok: true, data: { applied: false, reason: 'not_viewing' } })
    expect(frames).toEqual([])
  })

  it('refuses a wrong project, an unknown node and malformed input', async () => {
    expect(await cam({ action: 'fit', projectId: 'nope' })).toMatchObject({ ok: false })
    expect(await cam({ action: 'focus', node: 'Ghost' })).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['Ghost'] } })
    expect(await cam({ action: 'focus', node: 'n2' })).toMatchObject({ ok: true }) // by id too
    for (const bad of [{ action: 'spin' }, { action: 'focus' }, { action: 'zoom' }, { action: 'zoom', zoom: 'big' }, { action: 'pan' }, { action: 'fit', zoom: 1 }, { action: 'zoom', zoom: 1, dx: 1 }]) {
      expect(await cam(bad)).toMatchObject({ ok: false, code: 'invalid_shape' })
    }
    expect(frames).toHaveLength(1)
  })
})

describe('workspace.switch', () => {
  it('switches the visible workspace with a polite view frame', async () => {
    expect(await sw()).toMatchObject({ ok: true, data: { applied: true, workspaceId: 'w-p2', name: 'Beta WS' } })
    expect(active).toBe('w-p2')
    expect(frames).toEqual([{ t: 'view', workspaceId: 'w-p2', polite: true }])
  })

  it('is a no-op when that workspace is already on screen', async () => {
    expect(await sw({ projectId: 'p1' })).toMatchObject({ ok: true, data: { applied: true, already: true } })
    expect(frames).toEqual([])
  })

  it('waits for an idle human: user_active leaves the active workspace and sends nothing', async () => {
    idle = 500
    expect(await sw()).toMatchObject({ ok: true, data: { applied: false, reason: 'user_active' } })
    expect(active).toBe('w-p1')
    expect(frames).toEqual([])
    idle = null
    expect(await sw()).toMatchObject({ ok: true, data: { applied: false, reason: 'no_visible_window' } })
  })

  it('is R1 behind the flag, takes only projectId, and the guard still applies', async () => {
    expect(createWorkspaceSwitchDefs(deps).map((d) => [d.name, d.tier, d.flag])).toEqual([['workspace.switch', 'R1', READ_TOOLS_FLAG]])
    expect(await sw({}, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await sw({ extra: 1 })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await sw({ projectId: 'nope' })).toMatchObject({ ok: false })
    expect(await sw({}, ctx('R1', { [READ_TOOLS_FLAG]: 'on' }, { check: () => ({ ok: false, code: 'level_denied' }) }))).toMatchObject({ ok: false, code: 'level_denied' })
    expect(frames).toEqual([])
  })
})
