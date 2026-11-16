import { describe, expect, it, vi } from 'vitest'
import { buildHandleEntries, cableFor, spawnCenter, OFF_HINTS } from './handleMenu.model'
import type { HandleSpawners } from './handleMenu.model'
import { DEFAULT_SETTINGS } from '../shared/settings'

const ctx = { nodeCount: 1, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
const spawners = (over: Partial<HandleSpawners> = {}): HandleSpawners => ({
  addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), addBrowser: vi.fn(), addDiff: vi.fn(), addAgentChat: vi.fn(), link: vi.fn(), ...over,
})
const agent = (side: 'source' | 'target' = 'source') => ({ id: 'a', kind: 'agent', agentId: 'claude' as const, side })

describe('buildHandleEntries', () => {
  it('offers only kinds that can be cabled to an agent (no plain terminal, no files)', () => {
    const ids = buildHandleEntries(spawners(), ctx, agent()).map((e) => e.id)
    expect(ids).toContain('agent:claude')
    expect(ids).toContain('browser')
    expect(ids).toContain('diff')
    expect(ids).toContain('agentChat')
    expect(ids).not.toContain('terminal')
    expect(ids).not.toContain('files')
    expect(ids).not.toContain('select-all')
    expect(ids).not.toContain('fit-view')
  })

  it('offers nothing for a plain terminal origin', () => {
    expect(buildHandleEntries(spawners(), ctx, { id: 't', kind: 'terminal', side: 'source' })).toEqual([])
  })

  it('lists a missing feature as disabled with its reason, never hides it', () => {
    const entries = buildHandleEntries(spawners({ addBrowser: undefined, addAgentChat: undefined }), ctx, agent())
    expect(entries.find((e) => e.id === 'browser')).toMatchObject({ disabled: true, description: OFF_HINTS.browser })
    expect(entries.find((e) => e.id === 'agentChat')).toMatchObject({ disabled: true, description: OFF_HINTS.agentChat })
    expect(entries.find((e) => e.id === 'diff')?.disabled).toBeUndefined()
  })

  it('honours agents hidden in settings', () => {
    const ids = buildHandleEntries(spawners(), { ...ctx, disabledAgents: ['claude'] }, agent()).map((e) => e.id)
    expect(ids).not.toContain('agent:claude')
  })

  it('spawn(at) calls the real spawner with that exact point', () => {
    const s = spawners()
    const at = { x: 12, y: 34 }
    buildHandleEntries(s, ctx, agent()).find((e) => e.id === 'diff')?.spawn(at)
    expect(s.addDiff).toHaveBeenCalledWith(at)
    buildHandleEntries(s, ctx, agent()).find((e) => e.id === 'agent:claude')?.spawn(at)
    expect(s.addAgent).toHaveBeenCalledWith(expect.any(String), 'claude', at)
  })
})

describe('spawnCenter', () => {
  const origin = { x: 100, y: 100, width: 200, height: 100 }
  const size = { width: DEFAULT_SETTINGS.defaultNodeWidth, height: DEFAULT_SETTINGS.defaultNodeHeight }
  it('puts a target to the right and a source to the left, top-aligned', () => {
    const r = spawnCenter(origin, size, 'source', [])
    expect(r.x - size.width / 2).toBeGreaterThan(origin.x + origin.width)
    expect(r.y - size.height / 2).toBe(origin.y)
    const l = spawnCenter(origin, size, 'target', [])
    expect(l.x + size.width / 2).toBeLessThan(origin.x)
  })
  it('moves down past a node already in the spot', () => {
    const first = spawnCenter(origin, size, 'source', [])
    const blocker = { x: first.x - size.width / 2, y: first.y - size.height / 2, ...size }
    const next = spawnCenter(origin, size, 'source', [blocker])
    expect(next.y - size.height / 2).toBeGreaterThanOrEqual(blocker.y + blocker.height)
  })
})

describe('cableFor', () => {
  it('source handle cables origin -> new, target handle new -> origin', () => {
    expect(cableFor('o', 'n', 'source')).toMatchObject({ source: 'o', target: 'n' })
    expect(cableFor('o', 'n', 'target')).toMatchObject({ source: 'n', target: 'o' })
  })
})
