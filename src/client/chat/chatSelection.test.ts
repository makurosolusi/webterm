import { describe, expect, it } from 'vitest'
import { latestSteward, resolveSelection } from './chatSelection'

const steward = (id: string) => ({ id, mode: null })
const author = (id: string) => ({ id, mode: 'skill-author' })

describe('chatSelection', () => {
  it('latestSteward skips skill-author rows', () => {
    expect(latestSteward([author('a'), steward('s1'), steward('s2')])?.id).toBe('s1')
    expect(latestSteward([author('a')])).toBeNull()
  })
  it('keeps an existing steward selection', () => {
    expect(resolveSelection([steward('s1'), steward('s2')], 's2', false)).toBe('s2')
  })
  it('drops a non-explicit skill-author selection', () => {
    expect(resolveSelection([author('a'), steward('s1')], 'a', false)).toBe('s1')
    expect(resolveSelection([author('a')], 'a', false)).toBeNull()
  })
  it('keeps an explicit skill-author selection', () => {
    expect(resolveSelection([author('a'), steward('s1')], 'a', true)).toBe('a')
  })
  it('falls back to the newest steward when the id vanished', () => {
    expect(resolveSelection([author('a'), steward('s1')], 'gone', true)).toBe('s1')
  })
})
