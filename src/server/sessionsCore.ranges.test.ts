import { describe, expect, it } from 'vitest'
import { SessionsCore } from './sessionsCore'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SETTING_RANGES } from '../shared/settings.ranges'

// `scrollbackBytes` protected: subclass tipis untuk membacanya.
class Probe extends SessionsCore {
  get bytes(): number { return this.scrollbackBytes }
}
const bytesFor = (n: unknown) => new Probe({ scrollbackBytes: n as number }).bytes

describe('SessionsCore.scrollbackBytes', () => {
  it('menjepit ke [16 KiB, 64 MiB]', () => {
    expect(bytesFor(1)).toBe(16384)
    expect(bytesFor(1e12)).toBe(67108864)
    expect(bytesFor(SETTING_RANGES.scrollbackBytes.min)).toBe(16384)
    expect(bytesFor(1_000_000)).toBe(1_000_000)
  })

  it('tak sah atau absen jatuh ke default', () => {
    for (const bad of [undefined, NaN, '', null, 0 / 0]) expect(bytesFor(bad)).toBe(DEFAULT_SETTINGS.scrollbackBytes)
    expect(new Probe().bytes).toBe(DEFAULT_SETTINGS.scrollbackBytes)
  })
})
