import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_PRESETS, resolveDevice } from '../../shared/browser.devices'
import { learnEngine, parseProduct, setEngineForTest, userAgentParams } from './browserHost.device.identity'

afterEach(() => setEngineForTest(undefined))

interface Params { userAgent: string; platform?: string; userAgentMetadata?: { platform: string; mobile: boolean; brands: Array<{ brand: string; version: string }>; fullVersion: string; fullVersionList: Array<{ brand: string; version: string }> } }
const paramsOf = (id: string): Params => userAgentParams(resolveDevice({ id })!) as Params
const OS_OF_UA: Array<[RegExp, string, string]> = [[/iPhone/, 'iPhone', ''], [/iPad/, 'iPad', ''], [/Android/, 'Linux armv81', 'Android'], [/Windows NT/, 'Win32', 'Windows']]

describe('parseProduct', () => {
  it.each([
    ['Chrome/157.0.8103.79', { major: '157', full: '157.0.8103.79', brand: 'Google Chrome' }],
    ['Edg/150.0.1.2', { major: '150', full: '150.0.1.2', brand: 'Microsoft Edge' }],
    ['HeadlessChrome/150.0.1.2', { major: '150', full: '150.0.1.2' }],
  ])('%s', (p, want) => { expect(parseProduct(p)).toEqual(want) })
  it('rejects a string that is not product/version', () => { expect(parseProduct('nonsense')).toBeNull() })
})

describe('device presets: User-Agent, Client Hints and navigator.platform agree', () => {
  it('learnEngine reads the real engine once and a failing probe leaves the presets alone', async () => {
    await learnEngine(async () => { throw new Error('closed') })
    expect(paramsOf('pixel-8').userAgent).toContain('Chrome/150.0.0.0') // preset number, nothing learned
    await learnEngine(async () => ({ product: 'Chrome/157.0.8103.79' }))
    expect(paramsOf('pixel-8').userAgent).toContain('Chrome/157.0.0.0')
  })

  describe.each(DEVICE_PRESETS.filter((p) => p.ua))('%s', (p) => {
    it('platform token, navigator.platform and Client Hints name the same OS', () => {
      setEngineForTest({ major: '157', full: '157.0.8103.79', brand: 'Google Chrome' })
      const got = paramsOf(p.id)
      const [, navPlatform, chPlatform] = OS_OF_UA.find(([re]) => re.test(got.userAgent))!
      expect(got.platform).toBe(navPlatform)
      if (p.uaMeta) expect(got.userAgentMetadata?.platform).toBe(chPlatform)
      else expect(got.userAgentMetadata).toBeUndefined() // Safari-shaped UA: no Client Hints at all, like the real thing
    })

    it('a Chromium preset names the REAL engine major in the UA and every brand, with a full version list', () => {
      if (!p.uaMeta) return
      setEngineForTest({ major: '157', full: '157.0.8103.79', brand: 'Google Chrome' })
      const got = paramsOf(p.id)
      const meta = got.userAgentMetadata!
      expect(got.userAgent).toContain('Chrome/157.0.0.0')
      expect(meta.mobile).toBe(p.mobile)
      expect(meta.brands.filter((b) => b.brand !== 'Not-A.Brand').map((b) => b.version)).toEqual(['157', '157'])
      expect(meta.fullVersion).toBe('157.0.8103.79')
      expect(meta.fullVersionList.map((b) => b.brand)).toEqual(meta.brands.map((b) => b.brand))
    })
  })

  it('a Chromium build that is not Google Chrome never claims to be Google Chrome', () => {
    setEngineForTest({ major: '150', full: '150.0.1.2' })
    expect(paramsOf('pixel-8').userAgentMetadata?.brands.map((b) => b.brand)).toEqual(['Not-A.Brand', 'Chromium'])
  })

  it('desktop presets and Responsive override nothing', () => {
    expect(paramsOf('desktop-1440')).toEqual({ userAgent: '' })
  })
})
