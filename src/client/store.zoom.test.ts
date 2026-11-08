import { describe, expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'

describe('store browser zoom', () => {
  it('round-trips a saved page zoom; absent stays absent', () => {
    expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, zoom: 1.3 })).zoom).toBe(1.3)
    expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0 })).zoom).toBeUndefined()
  })

  it('drops junk and out-of-range zoom instead of persisting it', () => {
    for (const zoom of [0, 9, Number.NaN, '1.2' as unknown as number]) {
      expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, zoom })).zoom).toBeUndefined()
    }
  })
})
