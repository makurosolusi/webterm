// A node that cannot operate must say so on the wire: MAX_LIVE refusal, a failed launch (with its specific cause), and
// the retry when a slot frees. Before this, a refused attach reached the client as a generic `blocked` that faded after
// 4 s and left a page that looked alive (docs/decisions/browser-tabs.md, "A node that cannot operate").
import { afterEach, describe, expect, it } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import { BrowserError } from './browserHost.targets'
import { makeRig } from './browserWs.testkit'
import type { Client, Rig } from './browserWs.testkit'

let rig: Rig
afterEach(async () => { await rig?.stop() })
const wait = async (cond: () => boolean, what: string, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const attach = (over = {}) => ({ t: 'attach', id: 'n1', w: 800, h: 600, dpr: 1, ...over })
const errors = (c: Client) => c.json.filter((m) => m.t === 'error')

describe('refused attach is explicit', () => {
  it('MAX_LIVE refusal arrives as its own code, not the generic "blocked"', async () => {
    rig = await makeRig()
    rig.host.fail.open = new BlockedError('max_live')
    const c = await rig.connect()
    c.send(attach())
    await wait(() => errors(c).length > 0, 'error')
    expect(errors(c)[0]).toMatchObject({ t: 'error', id: 'n1', code: 'max_live' })
  })

  it('a failed launch carries the specific reason', async () => {
    rig = await makeRig()
    rig.host.fail.open = new BrowserError('launch_failed', 'open failed', undefined, undefined, 'profile_locked')
    const c = await rig.connect()
    c.send(attach())
    await wait(() => errors(c).length > 0, 'error')
    expect(errors(c)[0]).toMatchObject({ code: 'launch_failed', reason: 'profile_locked' })
  })
})

describe('wake when a slot frees', () => {
  it('retries the refused attach on capacity and the node goes live without asking again', async () => {
    const cbs = new Set<() => void>()
    rig = await makeRig({ onCapacity: (cb) => { cbs.add(cb); return () => { cbs.delete(cb) } } })
    rig.host.failOnce.open = new BlockedError('max_live')
    const c = await rig.connect()
    c.send(attach())
    await wait(() => errors(c).length > 0, 'refusal')
    expect(c.json.some((m) => m.t === 'state')).toBe(false)
    cbs.forEach((cb) => cb()) // a slot is free
    await wait(() => c.json.some((m) => m.t === 'state' && m.live === 'live'), 'state after the retry')
    expect(rig.host.opens).toEqual(['n1', 'n1'])
  })

  it('does not retry a node that detached while waiting', async () => {
    const cbs = new Set<() => void>()
    rig = await makeRig({ onCapacity: (cb) => { cbs.add(cb); return () => { cbs.delete(cb) } } })
    rig.host.failOnce.open = new BlockedError('max_live')
    const c = await rig.connect()
    c.send(attach())
    await wait(() => errors(c).length > 0, 'refusal')
    c.send({ t: 'detach', id: 'n1' })
    await new Promise((r) => setTimeout(r, 30))
    cbs.forEach((cb) => cb())
    await new Promise((r) => setTimeout(r, 40))
    expect(rig.host.opens).toEqual(['n1'])
  })
})

describe('attach names the profile the node was created on', () => {
  it('passes `profileId` to hintProfile before the node is opened', async () => {
    const seen: string[] = []
    rig = await makeRig({ hintProfile: (n, w, p) => { seen.push(`${n}:${w}:${p}`) } })
    const c = await rig.connect()
    c.send(attach({ profileId: 'bp-0123456789ab' }))
    await wait(() => c.json.some((m) => m.t === 'state'), 'state')
    expect(seen).toEqual(['n1:w1:bp-0123456789ab'])
  })
})
