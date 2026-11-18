import { afterEach, describe, expect, it } from 'vitest'
import { MAX_FRAMES_IN_FLIGHT } from '../../shared/browser.contract'
import { decodeFrameHeader } from '../../shared/browser.wire'
import { makeRig } from './browserWs.testkit'
import type { Client, Rig } from './browserWs.testkit'

let rig: Rig
afterEach(async () => { await rig?.stop() })
const wait = async (cond: () => boolean, what: string) => {
  const end = Date.now() + 2000
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 5)) }
}
async function attached(): Promise<Client> {
  const c = await rig.connect()
  c.send({ t: 'attach', id: 'n1', w: 800, h: 600, dpr: 1 })
  await wait(() => c.json.length > 0, 'attached')
  return c
}

describe('split view over the socket', () => {
  it('forwards the on-screen tabs and focus, and the size of one pane', async () => {
    rig = await makeRig()
    const c = await attached()
    c.send({ t: 'view', id: 'n1', visible: ['tab-a', 'tab-b'], focus: 'tab-b' })
    c.send({ t: 'resize', id: 'n1', tab: 'tab-a', w: 400, h: 300, dpr: 1 })
    await wait(() => rig.host.views.length === 1 && rig.host.tabViewports.length === 1, 'forwarded')
    expect(rig.host.views[0]).toEqual(['n1', ['tab-a', 'tab-b'], 'tab-b'])
    expect(rig.host.tabViewports[0]).toEqual(['n1', 'tab-a', 400, 300, 1])
    expect(rig.host.viewports).toHaveLength(1) // only the attach size: a pane resize does not touch the node's
  })

  it('refuses a malformed view or tab id', async () => {
    rig = await makeRig()
    const c = await attached()
    c.send({ t: 'view', id: 'n1', visible: ['ok', 'bad id!'] })
    c.send({ t: 'view', id: 'n1', visible: ['a', 'b', 'c', 'd', 'e'] })
    c.send({ t: 'resize', id: 'n1', tab: '../x', w: 4, h: 4, dpr: 1 })
    await wait(() => c.json.filter((m) => m.code === 'bad_request').length === 3, 'three rejections')
    expect(rig.host.views).toHaveLength(0)
  })

  it('carries the tab of an input to the host', async () => {
    rig = await makeRig()
    const c = await attached()
    c.send({ t: 'mouse', id: 'n1', type: 'down', x: 1, y: 2, button: 'left', tab: 'tab-b' })
    await wait(() => rig.host.inputs.length === 1, 'input')
    expect(rig.host.inputs[0].tab).toBe('tab-b')
  })

  it('frames of two panes reach the client with their tab; a newer frame replaces only its own pane', async () => {
    rig = await makeRig()
    const c = await attached()
    for (let s = 1; s <= MAX_FRAMES_IN_FLIGHT; s++) rig.host.emitFrame('n1', s) // fill the window
    await wait(() => c.bin.length === MAX_FRAMES_IN_FLIGHT, 'window full')
    rig.host.emitFrame('n1', 10, 'tab-a')
    rig.host.emitFrame('n1', 11, 'tab-b')
    rig.host.emitFrame('n1', 12, 'tab-a')
    c.send({ t: 'ack', id: 'n1', seq: 1 })
    c.send({ t: 'ack', id: 'n1', seq: 2 })
    await wait(() => c.bin.length === MAX_FRAMES_IN_FLIGHT + 2, 'both panes delivered')
    const got = c.bin.slice(MAX_FRAMES_IN_FLIGHT).map((b) => decodeFrameHeader(b)).map((h) => [h?.tabId, h?.seq])
    expect(got).toEqual([['tab-a', 12], ['tab-b', 11]])
  })
})
