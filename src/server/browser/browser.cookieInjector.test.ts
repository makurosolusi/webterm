import { afterEach, describe, expect, it } from 'vitest'
import { createCookieInjector } from './browser.cookieInjector'
import { CdpClient } from './cdp.client'
import { LaunchError } from './chromium.launch'
import { startFakeCdp } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'
import type { BrowserCookie } from './cookieImport.parse'

const CANARY = 'cookie-canary-value' // test-only
const cookie = (over: Partial<BrowserCookie> = {}): BrowserCookie => ({
  name: 'sid', value: CANARY, domain: 'a.example', path: '/', expires: -1, httpOnly: true, secure: true, ...over,
})

let fake: FakeCdp
afterEach(async () => { await fake.close() })

async function setup() {
  fake = await startFakeCdp()
  const acquired: string[] = []
  const launcher = { acquire: async (ws: string) => { acquired.push(ws); return fake.url }, shutdown: () => undefined }
  return { acquired, inj: createCookieInjector({ launcher, connect: (u) => CdpClient.connect(u) }) }
}

describe('createCookieInjector', () => {
  it('injects through Storage.setCookies, omitting expires for session cookies', async () => {
    const { inj, acquired } = await setup()
    await inj.inject('w1', [cookie(), cookie({ name: 'long', expires: 2_000_000_000 })])
    const call = fake.calls.find((c) => c.method === 'Storage.setCookies')!
    const sent = call.params.cookies as Array<Record<string, unknown>>
    expect(acquired).toEqual(['w1'])
    expect(sent[0]).not.toHaveProperty('expires')
    expect(sent[1]).toMatchObject({ name: 'long', expires: 2_000_000_000 })
  })

  it('removes only the matching domain by expiring its cookies', async () => {
    const { inj } = await setup()
    fake.handle('Storage.getCookies', () => ({ cookies: [
      { name: 'a', domain: '.a.example', path: '/' }, { name: 'b', domain: 'other.example', path: '/' },
    ] }))
    await inj.remove('w1', 'a.example')
    const set = fake.calls.find((c) => c.method === 'Storage.setCookies')!
    expect(set.params.cookies).toEqual([{ name: 'a', value: '', domain: '.a.example', path: '/', expires: 1 }])
  })

  it('clears everything when no domain is given', async () => {
    const { inj } = await setup()
    await inj.remove('w1')
    expect(fake.methods()).toContain('Storage.clearCookies')
  })

  it('skips profile cleanup without a binary but propagates other launch failures', async () => {
    fake = await startFakeCdp()
    const mk = (code: 'no_binary' | 'launch_failed') => createCookieInjector({
      launcher: { acquire: async () => { throw new LaunchError(code, 'x') }, shutdown: () => undefined },
    })
    await expect(mk('no_binary').remove('w1', 'a.example')).resolves.toBeUndefined()
    await expect(mk('launch_failed').remove('w1', 'a.example')).rejects.toBeInstanceOf(LaunchError)
  })
})
