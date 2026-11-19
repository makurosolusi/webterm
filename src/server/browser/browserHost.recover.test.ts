// A page Chromium reports as "Not attached to an active page": one recovery (activate + retry), then a visible error, never a stuck spinner.
import { afterEach, describe, expect, it } from 'vitest'
import { TargetGoneError } from './browserHost.service'
import { logBus } from '../logs'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const NOT_ACTIVE = { __error: { code: -32000, message: 'Not attached to an active page' } }
const callsOf = (method: string) => rig.fake.calls.filter((c) => c.method === method)
async function openLoading() {
  rig = await makeHostRig()
  await rig.host.open('n1', 'w1', 'https://example.com/')
  rig.fake.emit(CDP_EVENT.frameStartedLoading, { frameId: 'F1' }, 'S-T1')
  await new Promise((r) => setTimeout(r, 30))
  expect(rig.host.state('n1')?.loading).toBe(true)
}

describe('page not attached to an active page', () => {
  it('startScreencast: activates the target and retries once, the node stays live', async () => {
    await openLoading()
    let n = 0
    rig.fake.handle(CDP.startScreencast, () => (n++ === 0 ? NOT_ACTIVE : {}))
    await rig.host.startScreencast('n1', () => undefined)
    expect(callsOf(CDP.activateTarget)).toMatchObject([{ params: { targetId: 'T1' } }])
    expect(callsOf(CDP.startScreencast)).toHaveLength(2)
    expect(rig.host.state('n1')?.live).toBe('live')
  })

  it('startScreencast: still failing after the recovery -> visible error state and loading cleared', async () => {
    await openLoading()
    rig.fake.handle(CDP.startScreencast, () => NOT_ACTIVE)
    const err = await rig.host.startScreencast('n1', () => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TargetGoneError)
    expect(callsOf(CDP.startScreencast)).toHaveLength(2) // exactly one retry
    expect(rig.host.state('n1')).toMatchObject({ live: 'discarded', loading: false })
  })

  it('startScreencast: any other failure also clears loading', async () => {
    await openLoading()
    rig.fake.handle(CDP.startScreencast, () => ({ __error: { code: -32000, message: 'Some other failure' } }))
    await expect(rig.host.startScreencast('n1', () => undefined)).rejects.toThrow()
    expect(rig.host.state('n1')?.loading).toBe(false)
  })

  it('stop: stopLoading failing still clears loading and logs a warning', async () => {
    await openLoading()
    rig.fake.handle(CDP.stopLoading, () => ({ __error: { code: -32000, message: 'Some other failure' } }))
    await rig.host.navAction('n1', 'stop')
    expect(rig.host.state('n1')?.loading).toBe(false)
    expect(logBus.snapshot().some((e) => e.level === 'warn' && e.message === 'stop loading failed; clearing the loading flag')).toBe(true)
  })

  it('stop: a page that is not attached is recovered first, then stopLoading succeeds', async () => {
    await openLoading()
    let n = 0
    rig.fake.handle(CDP.stopLoading, () => (n++ === 0 ? NOT_ACTIVE : {}))
    await rig.host.navAction('n1', 'stop')
    expect(callsOf(CDP.activateTarget)).toHaveLength(1)
    expect(rig.host.state('n1')).toMatchObject({ live: 'live', loading: false })
  })
})
