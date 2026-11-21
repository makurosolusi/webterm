// WEBTERM_BROWSER_AUDIO_DEFAULT: registry entry (single home of the default) and the server reader the status endpoint uses.
import { describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { BROWSER_ENV_SPECS } from './browser.envRegistry'
import { audioDefaultOn } from './browser.runtime.parts'

const spec = BROWSER_ENV_SPECS.find((s) => s.key === ENV_BROWSER.audioDefault)

describe('browser audio default setting', () => {
  it('is a hot on/off flag in Browser, default on, with a plain label (audience is metadata only; the Settings row is a custom field)', () => {
    expect(spec).toBeDefined()
    expect(spec).toMatchObject({ kind: 'flag', default: 'on', section: 'Browser', audience: 'advanced', restartRequired: false, label: 'Play sound in new browser nodes' })
  })

  it('needs the browser switch (the audio kill switch is a UI lock in the Settings field, per the browser registry invariant)', () => {
    expect(spec?.requires?.map((r) => r.key)).toEqual([ENV_BROWSER.enabled])
  })

  it('the reader is on unless explicitly off', () => {
    expect(audioDefaultOn({})).toBe(true)
    expect(audioDefaultOn({ [ENV_BROWSER.audioDefault]: 'on' })).toBe(true)
    expect(audioDefaultOn({ [ENV_BROWSER.audioDefault]: 'off' })).toBe(false)
  })
})
