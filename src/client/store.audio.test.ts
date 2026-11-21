import { describe, expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'

// Three states: absent = never chosen = sound ON (default), false = the user muted it, legacy true = same as absent.
const round = (audio?: unknown) => toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, audio } as never)).audio

describe('store browser audio', () => {
  it('absent stays absent: a node that never chose is on by default', () => {
    expect(round(undefined)).toBeUndefined()
  })

  it('an explicit mute persists as false across the layout round trip', () => {
    expect(round(false)).toBe(false)
  })

  it('legacy `true` (old "sound was on" flag) normalizes to absent = on', () => {
    expect(round(true)).toBeUndefined()
  })

  it('drops junk instead of persisting it', () => {
    for (const audio of [1, 'yes', null] as unknown[]) expect(round(audio)).toBeUndefined()
  })
})
