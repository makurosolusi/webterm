// Target node lepas diam-diam dari Chromium (detach/tukar tanpa `discard`): node harus dilepas lalu dibuka ulang.
import { afterEach, describe, expect, it } from 'vitest'
import type { HostEvent } from './browserHost.service'
import { TargetGoneError } from './browserHost.service'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const SID = 'S-T1' // sessionId target pertama di server tiruan
const callsOf = (method: string) => rig.fake.calls.filter((c) => c.method === method)
async function openLive() {
  rig = await makeHostRig()
  const events: HostEvent[] = []
  rig.host.onEvent((e) => { if (e.k !== 'tab' && e.k !== 'tabNotice') events.push(e) }) // tab events are covered by the tabs tests
  await rig.host.open('n1', 'w1', 'https://example.com/')
  return events
}
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('lost page target', () => {
  it('detach of the main session unbinds the node, marks it discarded and raises crashed', async () => {
    const events = await openLive()
    rig.fake.emit(CDP_EVENT.detachedFromTarget, { sessionId: SID, targetId: 'T1' })
    await waitFor(() => events.length === 1, 'crash event')
    expect(events[0]).toEqual({ k: 'error', nodeId: 'n1', code: 'crashed' })
    expect(rig.host.state('n1')?.live).toBe('discarded')
    expect(await rig.host.open('n1', 'w1')).toMatchObject({ live: 'live' })
    expect(callsOf(CDP.createTarget)).toHaveLength(2)
  })

  it('detach of an iframe session leaves the node alone', async () => {
    const events = await openLive()
    rig.fake.emit(CDP_EVENT.detachedFromTarget, { sessionId: 'IFRAME-1' }, SID)
    await settle()
    expect(events).toHaveLength(0)
    expect(rig.host.state('n1')?.live).toBe('live')
  })

  it('our own discard followed by the detach event is not a crash', async () => {
    const events = await openLive()
    await rig.host.discard('n1')
    rig.fake.emit(CDP_EVENT.detachedFromTarget, { sessionId: SID, targetId: 'T1' })
    await settle()
    expect(events).toHaveLength(0)
  })

  it('a command answered with "Not attached to an active page" throws TargetGoneError and the next open makes a new target', async () => {
    const events = await openLive()
    rig.fake.handle(CDP.startScreencast, () => ({ __error: { code: -32000, message: 'Not attached to an active page' } }))
    const err = await rig.host.startScreencast('n1', () => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TargetGoneError)
    expect(err).toMatchObject({ code: 'crashed' })
    expect(rig.host.state('n1')?.live).toBe('discarded')
    expect(events).toEqual([{ k: 'error', nodeId: 'n1', code: 'crashed' }])
    expect(await rig.host.open('n1', 'w1')).toMatchObject({ live: 'live' })
    expect(callsOf(CDP.createTarget)).toHaveLength(2)
    expect(callsOf(CDP.navigate).at(-1)).toMatchObject({ params: { url: 'https://example.com/' }, sessionId: 'S-T2' })
  })

  it('another -32000 error is passed through without unbinding the node', async () => {
    await openLive()
    rig.fake.handle(CDP.startScreencast, () => ({ __error: { code: -32000, message: 'Some other failure' } }))
    const err = await rig.host.startScreencast('n1', () => undefined).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(TargetGoneError)
    expect(rig.host.state('n1')?.live).toBe('live')
  })
})
