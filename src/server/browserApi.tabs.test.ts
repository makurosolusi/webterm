import { describe, expect, it } from 'vitest'
import { BlockedError } from '../shared/browser.contract'
import { emptyTabsState } from '../shared/browser.tabs'
import { BrowserError } from './browser/browserHost.targets'
import { TabLimitError } from './browser/browserHost.tabs'
import { tabsRoute } from './browserApi.tabs'
import type { TabsApiDeps, TabsView } from './browserApi.tabs'

const view: TabsView = { state: emptyTabsState() }
const calls: string[] = []
const rec = (name: string) => async (...a: unknown[]) => { calls.push(`${name} ${a.join(' ')}`); return view }
const deps: TabsApiDeps = {
  get: (id) => (id === 'missing' ? null : view),
  newTab: rec('new'), activate: rec('activate'), close: rec('close'), move: rec('move'), duplicate: rec('dup'), popOut: rec('pop'), reopen: rec('reopen'),
  setLayout: async (id, layout, focus) => { calls.push(`layout ${id} ${JSON.stringify(layout)} ${focus ?? ''}`); return view },
  setDevice: async (id, tab, device) => { calls.push(`device ${id} ${tab} ${JSON.stringify(device)}`); return view },
}
const json = (v: unknown) => async () => JSON.stringify(v)
const none = async () => ''
const call = (m: string, id: string, rest: string[], b: () => Promise<string> = none, d = deps) => tabsRoute(m, id, rest, b, d)

describe('tabs api', () => {
  it('lists, 404s a node that is not a browser node', async () => {
    expect((await call('GET', 'n1', []))?.status).toBe(200)
    expect((await call('GET', 'missing', []))?.status).toBe(404)
  })

  it('routes every action with validated ids', async () => {
    calls.length = 0
    await call('POST', 'n1', [], json({ url: 'https://a.test/', afterTabId: 'tab-1' }))
    await call('POST', 'n1', ['tab-1', 'activate'])
    await call('DELETE', 'n1', ['tab-1'])
    await call('POST', 'n1', ['tab-1', 'move'], json({ toIndex: 2 }))
    await call('POST', 'n1', ['tab-1', 'duplicate'])
    await call('POST', 'n1', ['tab-1', 'pop-out'])
    await call('POST', 'n1', ['reopen'])
    expect(calls).toEqual(['new n1 [object Object]', 'activate n1 tab-1', 'close n1 tab-1', 'move n1 tab-1 2', 'dup n1 tab-1', 'pop n1 tab-1', 'reopen n1'])
  })

  it('rejects bad ids, urls, indexes and methods', async () => {
    expect((await call('POST', '../x', []))?.status).toBe(400)
    expect((await call('POST', 'n1', ['bad id!', 'activate']))?.status).toBe(400)
    expect((await call('POST', 'n1', [], json({ url: 'file:///etc/passwd' })))?.status).toBe(400)
    expect((await call('POST', 'n1', [], json({ afterTabId: '../x' })))?.status).toBe(400)
    expect((await call('POST', 'n1', ['tab-1', 'move'], json({ toIndex: -1 })))?.status).toBe(400)
    expect((await call('GET', 'n1', ['tab-1', 'activate']))?.status).toBe(405)
    expect((await call('POST', 'n1', ['tab-1', 'nope']))?.status).toBe(404)
  })

  it('maps limit, SSRF block, MAX_LIVE and unknown tab to statuses', async () => {
    const boom = (e: unknown): TabsApiDeps => ({ ...deps, newTab: async () => { throw e } })
    expect((await call('POST', 'n1', [], none, boom(new TabLimitError('n1'))))?.body).toMatchObject({ error: 'tab_limit', message: 'Tab limit (8) reached' })
    const blocked = await call('POST', 'n1', [], json({ url: 'http://10.0.0.1/' }), boom(new BlockedError('private_host', '10.0.0.1')))
    expect(blocked).toMatchObject({ status: 403, body: { error: 'blocked', reason: 'private_host' } })
    expect((await call('POST', 'n1', [], none, boom(new BlockedError('max_live'))))?.status).toBe(409)
    expect((await call('POST', 'n1', [], none, boom(new BrowserError('not_found', 'x'))))?.status).toBe(404)
  })

  it('stores a split layout and a per-tab device, validating both', async () => {
    calls.length = 0
    const tree = { dir: 'h', ratio: 0.5, a: { id: 'tab-1' }, b: { id: 'tab-2' } }
    expect((await call('PUT', 'n1', ['layout'], json({ layout: tree, focus: 'tab-2' })))?.status).toBe(200)
    expect((await call('PUT', 'n1', ['layout'], json({ layout: null })))?.status).toBe(200)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({ preset: 'ipad-mini' })))?.status).toBe(200)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({ w: 390, h: 844 })))?.status).toBe(200)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({ preset: null })))?.status).toBe(200)
    expect(calls).toEqual([
      `layout n1 ${JSON.stringify(tree)} tab-2`, 'layout n1 null ',
      'device n1 tab-1 {"id":"ipad-mini"}', 'device n1 tab-1 {"id":"custom","w":390,"h":844,"dpr":1}', 'device n1 tab-1 null',
    ])
    expect((await call('PUT', 'n1', ['layout'], json({ layout: { id: 'tab-1' } })))?.status).toBe(400) // one pane is not a split
    expect((await call('PUT', 'n1', ['layout'], json({ layout: tree, focus: '../x' })))?.status).toBe(400)
    expect((await call('GET', 'n1', ['layout']))?.status).toBe(405)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({ preset: 'nokia' })))?.status).toBe(400)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({ w: 5, h: 5 })))?.status).toBe(400)
    expect((await call('POST', 'n1', ['tab-1', 'device'], json({})))?.status).toBe(400)
  })
})
