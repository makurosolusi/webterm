// mergeCanvasPush with a pushed Layers group list (Central's canvas.group): an unsent save keeps the
// groups instead of reverting them, and the rest of the payload's layout is left alone.
import { describe, expect, it, vi } from 'vitest'
import type { CanvasMsg } from '../shared/protocol'
import { defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'
import { mergeCanvasPush, withPushedGroups } from './workspaceCanvasMerge'
import { createSaveQueue } from './workspaceSaveQueue'

const GROUP = { id: 'g1', name: 'Docs', collapsed: true, ids: ['c', 'a'] }
const layout = (order: string[]): TabLayout => ({ ...defaultTabLayout(), mode: 'tabs', tabs: { ...defaultTabLayout().tabs, order, active: 'b' } })
const board = (updatedAt: number, name = 'w', l: TabLayout | null = layout(['a', 'b', 'c'])): Workspace => ({ // test-only
  id: 'w1', name, viewport: DEFAULT_VIEWPORT, updatedAt, bridges: [], ...(l ? { layout: l } : {}),
  nodes: ['a', 'b', 'c'].map((id) => ({ id, kind: 'terminal' as const, x: 0, y: 0 })),
})
const push = { nodes: [], bridges: [], groups: [GROUP] }

describe('mergeCanvasPush groups', () => {
  it('takes the pushed groups, re-packed into the payload order; mode, active and files panel stay', () => {
    const ws = board(10)
    const out = mergeCanvasPush(ws, push)
    expect(out.layout?.tabs).toEqual({ ...ws.layout!.tabs, order: ['a', 'c', 'b'], groups: [{ ...GROUP, ids: ['a', 'c'] }] })
    expect(out.layout?.mode).toBe('tabs')
    expect(out.nodes).toEqual(ws.nodes)
  })

  it('appends a grouped member the payload order lacks; a board without a layout is left alone', () => {
    expect(withPushedGroups(layout(['a']), [GROUP]).tabs.order).toEqual(['a', 'c'])
    const bare = board(10, 'w', null)
    expect(mergeCanvasPush(bare, push)).toBe(bare) // its save keeps the stored (grouped) layout
    const ws = board(10)
    expect(mergeCanvasPush(ws, { nodes: [], bridges: [] })).toBe(ws)
  })

  it('a save locked before the push is sent with the pushed groups, on the push version', async () => {
    let stored = board(10)
    const sent: Workspace[] = []
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn() }, {
      save: vi.fn(async (ws: Workspace) => {
        sent.push(ws)
        await Promise.resolve()
        if (stored.updatedAt > ws.updatedAt) throw Object.assign(new Error('PUT -> 409'), { status: 409, body: { code: 'stale', current: stored } })
        stored = { ...ws, updatedAt: stored.updatedAt + 1 }
        return stored
      }),
    })
    const first = q.enqueue(board(10, 'first'))
    // the server groups while 'first' is in flight: it lands on top of 'first' (11 -> 12)
    await first
    const frame: CanvasMsg = { t: 'canvas', workspaceId: 'w1', base: stored.updatedAt, updatedAt: stored.updatedAt + 1, ...push }
    stored = mergeCanvasPush({ ...stored, updatedAt: frame.updatedAt }, push)
    const locked = q.enqueue(board(11, 'locked before the push')) // built from the old layout
    q.absorb(frame)
    await locked
    expect(stored.name).toBe('locked before the push')
    expect(stored.layout?.tabs.groups).toEqual([{ ...GROUP, ids: ['a', 'c'] }])
    expect(sent.at(-1)?.updatedAt).toBe(frame.updatedAt)
  })
})

describe('mergeCanvasPush name (Central workspace.rename)', () => {
  it('takes the pushed name and keeps nodes; the same name is the same object', () => {
    const ws = board(10, 'Old')
    const out = mergeCanvasPush(ws, { nodes: [], bridges: [], name: 'New' })
    expect(out).toEqual({ ...ws, name: 'New' })
    expect(mergeCanvasPush(ws, { nodes: [], bridges: [], name: 'Old' })).toBe(ws)
  })

  it('an unsent save made before the rename is sent with the new name, on the rename version', async () => {
    let stored = board(10, 'Old')
    const sent: Workspace[] = []
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn() }, {
      save: vi.fn(async (ws: Workspace) => {
        sent.push(ws)
        await Promise.resolve()
        if (stored.updatedAt > ws.updatedAt) throw Object.assign(new Error('PUT -> 409'), { status: 409, body: { code: 'stale', current: stored } })
        stored = { ...ws, updatedAt: stored.updatedAt + 1 }
        return stored
      }),
    })
    // Central renames (10 -> 11) while this window holds an edit built on version 10 with the old name.
    stored = { ...stored, name: 'Central', updatedAt: 11 }
    const edited = { ...board(10, 'Old'), viewport: { x: 5, y: 5, zoom: 1 } }
    const save = q.enqueue(edited)
    q.absorb({ t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes: [], bridges: [], name: 'Central' })
    await save
    expect(stored).toMatchObject({ name: 'Central', viewport: { x: 5, y: 5, zoom: 1 }, updatedAt: 12 })
    expect(sent.at(-1)).toMatchObject({ name: 'Central', updatedAt: 11 })
  })
})
