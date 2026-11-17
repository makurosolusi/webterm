/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSkillAuthorAdd } from '../agentChat.add'
import { validAgentChatData } from '../../shared/agentChat.shape'
import { buildAgentChatNode } from '../../shared/agentChat.node'
import { toWsNode } from '../store'
import { SKILL_AUTHOR_ACTIVITY } from './skillAuthor.events'
import { SKILL_AUTHOR_BANNER } from './skillAuthor.preset'
import { useSkillAuthorActivity } from './useSkillAuthorActivity'
import { fakeAgentChatTransport } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'

describe('creation path', () => {
  it('useSkillAuthorAdd makes a skill-author chat node with the target and returns its id', () => {
    const made: unknown[] = []
    const addFlowNode = vi.fn((make: (n: number, ws: { cwd?: string }) => unknown) => { made.push(make(0, { cwd: '/w' })) })
    const { result } = renderHook(() => useSkillAuthorAdd(addFlowNode as never, { disabledAgents: [], defaultClaudeProfileId: '' }))
    const id = result.current!('webterm-deploy')
    expect(made[0]).toMatchObject({ id, kind: 'agentChat', agentId: 'claude', preset: 'skill-author', presetTarget: 'webterm-deploy' })
    result.current!()
    expect(made[1]).not.toHaveProperty('presetTarget')
  })
  it('is unavailable while Claude is disabled', () => {
    const { result } = renderHook(() => useSkillAuthorAdd(vi.fn(), { disabledAgents: ['claude'], defaultClaudeProfileId: '' }))
    expect(result.current).toBeUndefined()
  })
  it('a plain chat node has no preset; the preset survives validation and the save round trip; junk is dropped', () => {
    expect(buildAgentChatNode('a', '/w', '')).not.toHaveProperty('preset')
    const n = buildAgentChatNode('a', '/w', '', { preset: 'skill-author', presetTarget: 'webterm-x' })
    expect(validAgentChatData(n)).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-x' })
    expect(validAgentChatData({ agentId: 'claude', preset: 'bogus' })).not.toHaveProperty('preset')
    const flow = { id: 'a', type: 'agentChat', position: { x: 0, y: 0 }, data: { ...n, presetPrimed: true } }
    expect(toWsNode(flow as never)).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-x' })
    expect(toWsNode(flow as never)).not.toHaveProperty('presetPrimed') // old field tolerated on load, never written
    expect(validAgentChatData({ ...n, presetPrimed: true })).not.toHaveProperty('presetPrimed')
  })
})

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

function mount(preset?: 'skill-author') {
  const f = fakeAgentChatTransport()
  const header = document.body.appendChild(document.createElement('div'))
  render(<AgentChatView nodeId="n1" onNodeData={vi.fn()} transport={f.t} headerHost={header} {...(preset ? { preset } : {})} />)
  f.emit()
  return f
}
const modeChip = () => screen.getByRole('button', { name: /^Permission mode/ })

describe('role is server-side: no client priming', () => {
  it('opening a preset chat sends nothing', () => {
    const { t } = mount('skill-author')
    expect(t.send).not.toHaveBeenCalled()
  })
  it('shows the role banner for a preset node only', () => {
    mount('skill-author')
    expect(screen.getByRole('note', { name: 'Chat role' }).textContent).toBe(SKILL_AUTHOR_BANNER)
    cleanup()
    mount()
    expect(screen.queryByRole('note', { name: 'Chat role' })).toBeNull()
  })
  it('the composer shows Locked and cannot switch the mode; a plain chat keeps its picker', () => {
    const { t } = mount('skill-author')
    expect(modeChip().textContent).toBe('Locked')
    expect(modeChip().getAttribute('aria-label')).toMatch(/Locked.*only run `webterm skills`/)
    fireEvent.keyDown(modeChip(), { key: 'Enter' })
    fireEvent.click(modeChip())
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(t.setMode).not.toHaveBeenCalled()
    cleanup()
    mount()
    expect(modeChip().textContent).not.toBe('Locked')
  })
})

describe('turn-finished report', () => {
  it('reports a finished turn of a skill-author chat to the Skills tab, and only that', () => {
    const seen: string[] = []
    const h = (e: Event) => seen.push((e as CustomEvent<{ nodeId: string }>).detail.nodeId)
    window.addEventListener(SKILL_AUTHOR_ACTIVITY, h)
    const { rerender } = renderHook((p: { busy: boolean }) => useSkillAuthorActivity('n1', 'skill-author', p.busy), { initialProps: { busy: true } })
    act(() => rerender({ busy: false }))
    const plain = renderHook((p: { busy: boolean }) => useSkillAuthorActivity('n2', undefined, p.busy), { initialProps: { busy: true } })
    act(() => plain.rerender({ busy: false }))
    window.removeEventListener(SKILL_AUTHOR_ACTIVITY, h)
    expect(seen).toEqual(['n1'])
  })
})
