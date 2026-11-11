/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { readDeveloperMode, resetDeveloperModeCache, writeDeveloperMode } from './developerMode'

afterEach(() => { resetDeveloperModeCache(); localStorage.clear(); history.replaceState(null, '', '/') })

describe('developer mode', () => {
  it('is off by default and remembers the Health switch', () => {
    expect(readDeveloperMode()).toBe(false)
    writeDeveloperMode(true)
    resetDeveloperModeCache()
    expect(readDeveloperMode()).toBe(true)
  })

  it('?dev=1 turns it on and is remembered; ?dev=0 turns it off', () => {
    history.replaceState(null, '', '/?dev=1')
    expect(readDeveloperMode()).toBe(true)
    history.replaceState(null, '', '/')
    resetDeveloperModeCache()
    expect(readDeveloperMode()).toBe(true)
    history.replaceState(null, '', '/?dev=0')
    resetDeveloperModeCache()
    expect(readDeveloperMode()).toBe(false)
  })
})
