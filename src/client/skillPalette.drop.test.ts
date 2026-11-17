// Canvas side of the palette drag: what a dragover accepts, which agent a drop lands on (flow-space hit-test), and the
// call into the board's one add function. Real pointer geometry is not here: jsdom has no layout (see skillPalette.canvas.test.tsx).
import type { DragEvent } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptSkillDrag, dropSkill } from './skillPalette.drop'
import { SKILL_DRAG_MIME, readSkillDrag, skillHostAt } from './skillPalette.drag'

const h = vi.hoisted(() => ({ showNotice: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: h.showNotice, closeNotice: vi.fn() }))
afterEach(() => vi.clearAllMocks())

// test-only fixtures
const node = (id: string, type: string, x: number, y: number, agentId = 'claude'): Node => ({ id, type, position: { x, y }, width: 100, height: 100, data: { agentId, title: id } })
const NODES = [node('a1', 'agent', 0, 0), node('t1', 'terminal', 300, 0), node('x1', 'agent', 600, 0, 'codex')]
const payload = JSON.stringify({ name: 'webterm-release', version: '4' })
const event = (data: Record<string, string>, clientX = 0, clientY = 0): DragEvent => ({
  dataTransfer: { types: Object.keys(data), getData: (t: string) => data[t] ?? '', dropEffect: '' },
  preventDefault: vi.fn(), clientX, clientY,
}) as unknown as DragEvent
const rf = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x - 10, y: y - 10 }) } as ReactFlowInstance

describe('skillHostAt', () => {
  it('finds the Claude agent under the point; a terminal, a non-Claude agent or empty space is no host', () => {
    expect(skillHostAt(NODES, { x: 50, y: 50 })?.id).toBe('a1')
    expect(skillHostAt(NODES, { x: 350, y: 50 })).toBeUndefined()
    expect(skillHostAt(NODES, { x: 650, y: 50 })).toBeUndefined()
    expect(skillHostAt(NODES, { x: 200, y: 50 })).toBeUndefined()
  })

  it('the topmost node wins: a node drawn over an agent hides it', () => {
    expect(skillHostAt([node('a1', 'agent', 0, 0), node('t1', 'terminal', 20, 20)], { x: 50, y: 50 })).toBeUndefined()
  })
})

describe('payload', () => {
  it('reads a valid skill and rejects garbage', () => {
    expect(readSkillDrag({ getData: () => payload })).toEqual({ name: 'webterm-release', version: '4' })
    expect(readSkillDrag({ getData: () => 'not json' })).toBeNull()
    expect(readSkillDrag({ getData: () => '{"name":3}' })).toBeNull()
  })
})

describe('dragover / drop', () => {
  it('dragover accepts only a skill drag', () => {
    const e = event({ [SKILL_DRAG_MIME]: payload })
    expect(acceptSkillDrag(e)).toBe(true)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(acceptSkillDrag(event({ 'text/plain': 'x' }))).toBe(false)
  })

  it('a drop on an agent asks the board to attach to it and reports it', () => {
    const add = vi.fn(() => ({ status: 'attached' as const }))
    expect(dropSkill(event({ [SKILL_DRAG_MIME]: payload }, 60, 60), rf, NODES, add)).toBe(true)
    expect(add).toHaveBeenCalledWith({ name: 'webterm-release', version: '4' }, { hostId: 'a1' })
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), { title: 'Added to the canvas and attached to a1.', severity: 'info' })
  })

  it('a drop on empty canvas adds a bare node at the flow point', () => {
    const add = vi.fn(() => ({ status: 'added' as const }))
    dropSkill(event({ [SKILL_DRAG_MIME]: payload }, 510, 410), rf, NODES, add)
    expect(add).toHaveBeenCalledWith({ name: 'webterm-release', version: '4' }, { at: { x: 500, y: 400 } })
  })

  it('a ninth skill dropped on a full agent warns instead of going quiet', () => {
    dropSkill(event({ [SKILL_DRAG_MIME]: payload }, 60, 60), rf, NODES, () => ({ status: 'limit' }))
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ severity: 'warning', title: expect.stringContaining('already has 8 skills') }))
  })

  it('a malformed payload adds nothing; another drag is left to the other handlers', () => {
    const add = vi.fn()
    expect(dropSkill(event({ [SKILL_DRAG_MIME]: 'oops' }), rf, NODES, add)).toBe(true)
    expect(add).not.toHaveBeenCalled()
    expect(dropSkill(event({ 'text/uri-list': 'https://x.test' }), rf, NODES, add)).toBe(false)
  })
})
