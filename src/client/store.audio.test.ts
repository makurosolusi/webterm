import { describe, expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'

describe('store browser audio', () => {
  it('saves "sound was on" in the layout; absent (muted) stays absent', () => {
    expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, audio: true })).audio).toBe(true)
    expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0 })).audio).toBeUndefined()
  })

  it('drops junk instead of persisting it', () => {
    for (const audio of [false, 1, 'yes'] as unknown[]) {
      expect(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, audio } as never)).audio).toBeUndefined()
    }
  })
})
