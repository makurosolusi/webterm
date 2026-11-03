import { describe, it, expect } from 'vitest'
import {
  BROWSER_CAPS, BROWSER_VERB_CAP, BlockedError, DSF_MAX, ENV_BROWSER, ID_MAX_BYTES,
  MAX_FRAMES_IN_FLIGHT, MOD,
} from './browser.contract'

describe('browser.contract', () => {
  it('nilai §4.1 yang dipakai lintas WS tidak bergeser diam-diam', () => {
    expect(MAX_FRAMES_IN_FLIGHT).toBe(2)
    expect(DSF_MAX).toBe(2)
    expect(ID_MAX_BYTES).toBe(255)
    expect(MOD).toEqual({ Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 })
  })

  it('setiap verb punya capability read/act yang dikenal; read vs act sesuai §4.6', () => {
    const caps = Object.values(BROWSER_CAPS)
    for (const cap of Object.values(BROWSER_VERB_CAP)) expect(caps).toContain(cap)
    expect(Object.keys(BROWSER_VERB_CAP).sort()).toEqual(
      ['click', 'handoff', 'navigate', 'press', 'release', 'screenshot', 'scroll', 'snapshot', 'status', 'type', 'wait'])
    expect(BROWSER_VERB_CAP.snapshot).toBe('browser.read')
    expect(BROWSER_VERB_CAP.click).toBe('browser.act')
  })

  it('semua nama env berawalan WEBTERM_BROWSER dan unik', () => {
    const names = Object.values(ENV_BROWSER)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n.startsWith('WEBTERM_BROWSER')).toBe(true)
  })

  it('BlockedError membawa reason + hostname saja', () => {
    const e = new BlockedError('private_host', 'localhost')
    expect(e).toBeInstanceOf(Error)
    expect(e.reason).toBe('private_host')
    expect(e.message).toBe('browser navigation blocked: private_host (localhost)')
  })
})
