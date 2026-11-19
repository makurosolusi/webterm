// A conversation without a mode is the steward and gets the steward's full registry profile; only a mode narrows it.
import { afterEach, describe, expect, it } from 'vitest'
import { registerCapabilityMap } from '../context/capabilityMap'
import { profileOf } from './turnNotes'

let unregister = (): void => undefined
afterEach(() => unregister())

describe('profileOf', () => {
  it('a conversation with no mode uses central.steward', () => {
    unregister = registerCapabilityMap(() => [{ name: 'browser_read', access: 'auto' }])
    expect(profileOf({ mode: null })?.profile).toBe('central.steward')
  })
  it('a skill-author conversation uses central.skill-author', () => {
    expect(profileOf({ mode: 'skill-author' })).toEqual({ profile: 'central.skill-author', off: new Set() })
  })
})
