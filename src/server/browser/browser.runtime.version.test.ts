import { afterEach, describe, expect, it } from 'vitest'
import { readBrowserProduct, CdpClient } from './cdp.client'
import { createVersionProbe } from './browser.runtime.version'
import { startFakeCdp, waitFor } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

let fake: FakeCdp
afterEach(async () => { await fake?.close() })
const versionCalls = () => fake.methods().filter((m) => m === 'Browser.getVersion').length
async function rig() {
  fake = await startFakeCdp()
  fake.handle('Browser.getVersion', () => ({ product: 'Chrome/131.0.1', userAgent: 'Mozilla/5.0 secret-ua' }))
  return createVersionProbe({ acquire: async () => fake.url })
}

describe('readBrowserProduct', () => {
  it('returns product only, not the user agent', async () => {
    fake = await startFakeCdp()
    fake.handle('Browser.getVersion', () => ({ product: 'Chrome/131.0.1', userAgent: 'ua' }))
    const c = await CdpClient.connect(fake.url)
    expect(await readBrowserProduct(c)).toBe('Chrome/131.0.1')
    c.close()
  })
  it('rejects with context when product is missing', async () => {
    fake = await startFakeCdp()
    const c = await CdpClient.connect(fake.url)
    await expect(readBrowserProduct(c)).rejects.toThrow(/Browser\.getVersion returned no product/)
    c.close()
  })
})

describe('version probe', () => {
  it('is absent before probe, fills from CDP, and calls CDP once across repeated probes', async () => {
    const p = await rig()
    expect(p.get()).toBeUndefined()
    p.probe('w1'); p.probe('w1')
    await waitFor(() => p.get() !== undefined, 'version cached')
    p.probe('w1'); p.probe('w1')
    expect(p.get()).toBe('Chrome/131.0.1')
    expect(versionCalls()).toBe(1)
  })
  it('stays absent without throwing when getVersion fails, then retries on next probe', async () => {
    const p = await rig()
    fake.handle('Browser.getVersion', () => ({ __error: { code: -32000, message: 'nope' } }))
    p.probe('w1')
    await waitFor(() => versionCalls() === 1, 'first call')
    await new Promise((r) => setTimeout(r, 30))
    expect(p.get()).toBeUndefined()
    fake.handle('Browser.getVersion', () => ({ product: 'Chrome/132.0.0' }))
    p.probe('w1')
    await waitFor(() => p.get() === 'Chrome/132.0.0', 'retry succeeds')
  })
  it('clears the cache on reset and re-reads; a stale in-flight result cannot overwrite', async () => {
    const p = await rig()
    p.probe('w1')
    await waitFor(() => p.get() !== undefined, 'cached')
    p.reset()
    expect(p.get()).toBeUndefined()
    fake.handle('Browser.getVersion', () => ({ product: 'Chrome/140.0.0' }))
    p.probe('w1')
    await waitFor(() => p.get() === 'Chrome/140.0.0', 'new version')
    expect(versionCalls()).toBe(2)
    let release = () => {}
    fake.handle('Browser.getVersion', async () => { await new Promise<void>((r) => { release = r }); return { product: 'Chrome/old' } })
    p.reset(); p.probe('w1')
    await waitFor(() => versionCalls() === 3, 'slow call sent')
    p.reset()
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(p.get()).toBeUndefined()
  })
})
