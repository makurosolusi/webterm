/** @vitest-environment jsdom */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSkillAuthorAdd } from '../agentChat.add'
import { validAgentChatData } from '../../shared/agentChat.shape'
import { buildAgentChatNode } from '../../shared/agentChat.node'
import { toWsNode } from '../store'
import type { AgentChatTransport } from './agentChatTransport'
import { SKILL_AUTHOR_ACTIVITY } from './skillAuthor.events'
import { skillAuthorInstruction } from './skillAuthor.preset'
import { useSkillAuthorPriming } from './useSkillAuthorPriming'

describe('skill-author instruction', () => {
  const text = skillAuthorInstruction()
  it('discusses first and waits for an explicit go before writing', () => {
    expect(text).toMatch(/DISCUSS first/)
    expect(text).toMatch(/OUTLINE/)
    expect(text).toMatch(/wait for the human to say "go"/)
    expect(text.indexOf('"go"')).toBeLessThan(text.indexOf('webterm skills propose'))
  })
  it('proposes through the CLI and never claims the skill is active', () => {
    expect(text).toMatch(/webterm skills propose/)
    expect(text).toMatch(/waiting for approval in the Skills tab/)
    expect(text).toMatch(/NEVER say or imply the skill is active/)
  })
  it('states the lint limits', () => {
    expect(text).toMatch(/No shell commands, URLs, file paths or secrets/)
    expect(text).toMatch(/4000 characters/)
    expect(text).toMatch(/at most 300/)
  })
  it('an edit reads the current body first and uses `skills edit` on the target', () => {
    const edit = skillAuthorInstruction('webterm-deploy')
    expect(edit).toMatch(/webterm skills list webterm-deploy/)
    expect(edit).toMatch(/webterm skills edit webterm-deploy/)
    expect(edit.indexOf('skills list')).toBeLessThan(edit.indexOf('DISCUSS first'))
  })
})

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
    expect(toWsNode(flow as never)).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-x', presetPrimed: true })
  })
})

const transport = (send = vi.fn(async (_text: string) => undefined)) => ({ send }) as unknown as AgentChatTransport & { send: typeof send }

describe('priming', () => {
  const base = { nodeId: 'n1', preset: 'skill-author' as const, ready: true, busy: false, markPrimed: vi.fn() }
  it('sends the instruction once the stream is open, then marks the node primed', async () => {
    const t = transport()
    const markPrimed = vi.fn()
    renderHook(() => useSkillAuthorPriming({ ...base, presetTarget: 'webterm-x', transport: t, markPrimed }))
    await waitFor(() => expect(markPrimed).toHaveBeenCalledTimes(1))
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.send.mock.calls[0][0]).toBe(skillAuthorInstruction('webterm-x'))
  })
  it('does nothing for a plain chat, before the stream opens, once primed, or with a session', () => {
    const t = transport()
    renderHook(() => useSkillAuthorPriming({ ...base, preset: undefined, transport: t }))
    renderHook(() => useSkillAuthorPriming({ ...base, ready: false, transport: t }))
    renderHook(() => useSkillAuthorPriming({ ...base, presetPrimed: true, transport: t }))
    renderHook(() => useSkillAuthorPriming({ ...base, chatSessionId: 's1', transport: t }))
    expect(t.send).not.toHaveBeenCalled()
  })
  it('reports a finished turn to the Skills tab', () => {
    const seen: string[] = []
    const h = (e: Event) => seen.push((e as CustomEvent<{ nodeId: string }>).detail.nodeId)
    window.addEventListener(SKILL_AUTHOR_ACTIVITY, h)
    const { rerender } = renderHook((p: { busy: boolean }) => useSkillAuthorPriming({ ...base, presetTarget: undefined, presetPrimed: true, transport: transport(), busy: p.busy }), { initialProps: { busy: true } })
    act(() => rerender({ busy: false }))
    window.removeEventListener(SKILL_AUTHOR_ACTIVITY, h)
    expect(seen).toEqual(['n1'])
  })
})
