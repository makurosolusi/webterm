/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActEntry } from './centralAct.store'
import { createFollowController, FOLLOW_DWELL_MS, FOLLOW_PAUSE_MS, readFollowOn } from './centralFollow'

let seq = 0
const act = (nodeId: string, over: Partial<ActEntry> = {}): ActEntry => ({ nodeId, verb: 'typed', tool: 't', n: 1, ts: 0, seq: ++seq, ...over })
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

function setup(over: { zoom?: number; hidden?: boolean; tabs?: boolean; focused?: string | null; open?: string[]; ws?: string } = {}) {
  const state = { hidden: over.hidden ?? false, tabs: over.tabs ?? false, focused: over.focused ?? null }
  const open = new Set(over.open ?? ['agent', 'browser', 'a', 'b', 'c', 'd', 'e'])
  const rf = {
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: over.zoom ?? 0.21 })),
    fitView: vi.fn(async (_o?: unknown) => true),
    getNode: vi.fn((id: string) => (open.has(id) ? ({ id, position: { x: 0, y: 0 }, measured: { width: 100, height: 100 } } as never) : undefined)),
    setNodes: vi.fn(),
  }
  const ctl = createFollowController({
    getRf: () => rf, workspaceId: () => over.ws ?? 'w1', focusedId: () => state.focused, isHidden: () => state.hidden, isTabMode: () => state.tabs,
  })
  const fitted = () => rf.fitView.mock.calls.map((c) => (c[0] as unknown as { nodes: { id: string }[] }).nodes[0]?.id)
  return { rf, ctl, state, fitted, open }
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); seq = 0; document.body.innerHTML = '' })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Follow order and pacing', () => {
  it('goes agent first, then its browser (nodeId2) after the dwell', async () => {
    const { ctl, fitted } = setup()
    ctl.feed([act('agent', { verb: 'spawned', nodeId2: 'browser' })])
    await tick(0)
    expect(fitted()).toEqual(['agent'])
    await tick(FOLLOW_DWELL_MS - 1)
    expect(fitted()).toEqual(['agent'])
    await tick(1)
    expect(fitted()).toEqual(['agent', 'browser'])
  })
  it('merges repeated actions on the same node', async () => {
    const { ctl, fitted } = setup()
    ctl.feed([act('a')]); ctl.feed([act('a')]); ctl.feed([act('a')])
    await tick(FOLLOW_DWELL_MS * 3)
    expect(fitted()).toEqual(['a'])
  })
  it('a queue past 3 jumps to the newest and counts the rest as "more"', async () => {
    const { ctl, fitted } = setup()
    ctl.feed([act('a')])
    await tick(0)
    ctl.feed([act('b'), act('c'), act('d'), act('e')])
    expect(ctl.getView().more).toBe(4) // 3 skipped + the newest, waiting
    await tick(FOLLOW_DWELL_MS)
    expect(fitted()).toEqual(['a', 'e'])
  })
  it('only the verbs that move the subject are followed; closed nodes and other boards are skipped, never switched to', async () => {
    const { ctl, fitted } = setup({ open: ['b'] })
    ctl.feed([act('a', { verb: 'closed' }), act('x', { workspaceId: 'w9' }), act('gone'), act('b')])
    await tick(FOLLOW_DWELL_MS * 5)
    expect(fitted()).toEqual(['b'])
  })
  it('a node already readable stays put', async () => {
    const { ctl, rf } = setup({ zoom: 1 })
    ctl.feed([act('a')])
    await tick(0)
    expect(rf.fitView).not.toHaveBeenCalled()
  })
})

describe('Follow switch', () => {
  it('is ON by default; OFF means no movement at all and is remembered', async () => {
    expect(readFollowOn()).toBe(true)
    const { ctl, rf } = setup()
    ctl.setOn(false)
    expect(readFollowOn()).toBe(false)
    ctl.feed([act('a', { verb: 'spawned' })])
    await tick(FOLLOW_DWELL_MS * 2)
    expect(rf.fitView).not.toHaveBeenCalled()
    expect(ctl.getView().status).toBe('off')
  })
  it('broken storage does not throw and reads as ON', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readFollowOn()).toBe(true)
    expect(() => createFollowController({ getRf: () => null, workspaceId: () => null }).setOn(false)).not.toThrow()
  })
})

describe('Follow yields to the user', () => {
  it('a canvas interaction pauses it for the cool-down, then it resumes', async () => {
    const { ctl, fitted } = setup()
    ctl.userMoved()
    ctl.feed([act('a')])
    await tick(FOLLOW_PAUSE_MS - 1000)
    expect(fitted()).toEqual([])
    expect(ctl.getView().status).toBe('paused')
    await tick(1500)
    expect(fitted()).toEqual(['a'])
    expect(ctl.getView().status).toBe('following')
  })
  it('never moves while a pointer is held (drag / resize)', async () => {
    const { ctl, fitted } = setup()
    ctl.userMoved('down')
    ctl.feed([act('a')])
    await tick(FOLLOW_PAUSE_MS / 2)
    expect(fitted()).toEqual([])
    ctl.userMoved('up')
    await tick(FOLLOW_PAUSE_MS + 1000)
    expect(fitted()).toEqual(['a'])
  })
  it('a click outside the canvas (pointer up without a down) does not pause', async () => {
    const { ctl, fitted } = setup()
    ctl.userMoved('up')
    ctl.feed([act('a')])
    await tick(0)
    expect(fitted()).toEqual(['a'])
  })
  it('holds while the user works in another node, offering the node instead; resumes when they leave it', async () => {
    const { ctl, fitted, state } = setup({ focused: 'b' })
    ctl.feed([act('a')])
    await tick(3000)
    expect(fitted()).toEqual([])
    expect(ctl.getView()).toMatchObject({ status: 'held', heldNodeId: 'a' })
    state.focused = null
    await tick(1000)
    expect(fitted()).toEqual(['a'])
  })
})

describe('Follow guards', () => {
  it('never touches selection or keyboard focus', async () => {
    document.body.innerHTML = '<input id="mine"><div class="react-flow__node" data-id="a" tabindex="0"></div>'
    document.getElementById('mine')?.focus()
    const { ctl, rf } = setup()
    ctl.feed([act('a')])
    await tick(0)
    expect(rf.fitView).toHaveBeenCalledTimes(1)
    expect(rf.setNodes).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('mine')
  })
  it('tab mode: no camera movement; hidden tab: waits until visible', async () => {
    const tabs = setup({ tabs: true })
    tabs.ctl.feed([act('a')])
    await tick(FOLLOW_DWELL_MS * 2)
    expect(tabs.rf.fitView).not.toHaveBeenCalled()
    const hid = setup({ hidden: true })
    hid.ctl.feed([act('a')])
    await tick(2000)
    expect(hid.rf.fitView).not.toHaveBeenCalled()
    hid.state.hidden = false
    await tick(1000)
    expect(hid.fitted()).toEqual(['a'])
  })
  it('a node that appears a beat after its act is still followed', async () => {
    const { ctl, fitted, open } = setup({ open: [] })
    ctl.feed([act('a', { verb: 'spawned' })])
    await tick(600)
    open.add('a')
    await tick(400)
    expect(fitted()).toEqual(['a'])
  })
})
