import { describe, expect, it, vi } from 'vitest'
import { buildMemoryContext } from './contextBuilder'

vi.mock('../../memory/memorySearch', () => ({
  searchMemory: vi.fn(),
}))

import { searchMemory } from '../../memory/memorySearch'

const hit = (projectId: string, key: string, body: string, status: 'fact' | 'claim' | 'quarantine' = 'fact') => ({
  id: `${projectId}-${key}`, projectId, scope: 'project' as const, key, title: key, body, status,
  sourceKind: 'test', sourceRef: 'test', supersedes: null, supersededAt: null,
  createdAt: 1, updatedAt: 1, rank: 0,
})

describe('buildMemoryContext', () => {
  it('returns only facts for the conversation project', () => {
    vi.mocked(searchMemory).mockImplementation((_db, projectId) => projectId === 'p1'
      ? [hit('p1', 'owner', 'Alice'), hit('p1', 'claim', 'ignore', 'claim'), hit('p1', 'quarantine', 'ignore', 'quarantine')]
      : [hit('p2', 'other', 'Nope')])
    const result = buildMemoryContext({} as never, 'central:project:p1', 'owner')
    const otherProject = buildMemoryContext({} as never, 'central:project:p2', 'owner')
    expect(vi.mocked(searchMemory)).toHaveBeenCalledWith({}, 'p1', 'owner', 6)
    expect(result).toContain('- owner: Alice')
    expect(result).not.toContain('ignore')
    expect(otherProject).toContain('- other: Nope')
    expect(result).not.toContain('Nope')
  })

  it('returns empty context for global conversations and search failures', () => {
    expect(buildMemoryContext({} as never, 'central:global', 'anything')).toBe('')
    vi.mocked(searchMemory).mockImplementation(() => { throw new Error('broken table') })
    expect(buildMemoryContext({} as never, 'central:project:p1', 'anything')).toBe('')
  })

  it('caps by complete fact lines and redacts secret-looking values', () => {
    vi.mocked(searchMemory).mockReturnValue([
      hit('p1', 'secret', 'token sk-12345678901234567890'),
      hit('p1', 'long', 'x'.repeat(300)),
      hit('p1', 'later', 'must be omitted'),
    ])
    const result = buildMemoryContext({} as never, 'central:project:p1', 'query', { maxChars: 150 })
    expect(result.length).toBeLessThanOrEqual(150)
    expect(result).toContain('[redacted]')
    expect(result).not.toContain('x'.repeat(300))
    expect(result.split('\n').every((line) => line.startsWith('Known') || line.startsWith('- '))).toBe(true)
  })
})
