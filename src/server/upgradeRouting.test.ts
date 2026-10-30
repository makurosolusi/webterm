import { describe, expect, it } from 'vitest'
import { upgradeRoute } from './upgradeRouting'

describe('upgradeRoute', () => {
  it('claims the ws path in dev and prod', () => {
    expect(upgradeRoute('/ws', '/ws', true)).toBe('ws')
    expect(upgradeRoute('/ws', '/ws', false)).toBe('ws')
  })
  it('leaves other paths to Vite in dev', () => {
    expect(upgradeRoute('/', '/ws', true)).toBe('ignore')
    expect(upgradeRoute('/ws/extra', '/ws', true)).toBe('ignore')
  })
  it('destroys other paths in prod', () => {
    expect(upgradeRoute('/', '/ws', false)).toBe('destroy')
    expect(upgradeRoute('/ws/extra', '/ws', false)).toBe('destroy')
  })
})
