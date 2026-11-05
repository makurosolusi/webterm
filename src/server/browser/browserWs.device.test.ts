import { afterEach, describe, expect, it } from 'vitest'
import { makeRig } from './browserWs.testkit'
import type { Rig } from './browserWs.testkit'

let rig: Rig
afterEach(async () => { await rig?.stop() })
const wait = async (cond: () => boolean, what: string) => {
  const end = Date.now() + 2000
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('gateway device message', () => {
  it('forwards a validated device choice (and Responsive) to the host', async () => {
    rig = await makeRig()
    const c = await rig.connect()
    c.send({ t: 'attach', id: 'n1', w: 800, h: 600, dpr: 1 })
    await wait(() => c.json.length > 0, 'state after attach')
    c.send({ t: 'device', id: 'n1', device: { id: 'pixel-8', landscape: true } })
    c.send({ t: 'device', id: 'n1', device: null })
    await wait(() => rig.host.devices.length === 2, 'two device calls')
    expect(rig.host.devices).toEqual([['n1', { id: 'pixel-8', landscape: true }], ['n1', null]])
  })

  it('rejects an invalid device without calling the host', async () => {
    rig = await makeRig()
    const c = await rig.connect()
    c.send({ t: 'attach', id: 'n1', w: 800, h: 600, dpr: 1 })
    await wait(() => c.json.length > 0, 'state after attach')
    c.send({ t: 'device', id: 'n1', device: { id: 'custom', w: 99999, h: 1, dpr: 1 } })
    await wait(() => c.json.some((m) => (m as { code?: string }).code === 'bad_request'), 'bad_request')
    expect(rig.host.devices).toEqual([])
  })
})
