import { describe, expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'

// Three saved states: absent = never chosen (follows the Settings default), true = the user turned sound on, false = the user muted it.
const round = (audio?: unknown) => toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0, audio } as never)).audio

describe('store browser audio', () => {
  it('absent stays absent: a node that never chose follows the Settings default', () => {
    expect(round(undefined)).toBeUndefined()
  })

  it('an explicit mute persists as false across the layout round trip', () => {
    expect(round(false)).toBe(false)
  })

  it('an explicit unmute persists as true (not normalized away)', () => {
    expect(round(true)).toBe(true)
  })

  it('drops junk instead of persisting it', () => {
    for (const audio of [1, 'yes', null] as unknown[]) expect(round(audio)).toBeUndefined()
  })
})
