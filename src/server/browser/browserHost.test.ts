import { afterEach, describe, expect, it } from 'vitest'
import { BlockedError, DSF_MAX } from '../../shared/browser.contract'
import type { BrowserInputEvent, BrowserState, Frame } from '../../shared/browser.contract'
import { BrowserHost, BrowserError } from './browserHost.service'
import type { HostEvent } from './browserHost.service'
import { newRec, pushFrame } from './browserHost.targets'
import { CDP, CDP_EVENT } from './cdp.client'
import { DENIED_PERMISSIONS } from './chromium.flags'
import { LaunchError } from './chromium.launch'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const SID = 'S-T1' // sessionId yang dibuat server tiruan untuk target pertama
const callsOf = (method: string) => rig.fake.calls.filter((c) => c.method === method)
async function openLive(url = 'https://example.com/') {
  rig = await makeHostRig(stubGuard(['evil.test']))
  const events: HostEvent[] = []
  const states: BrowserState[] = []
  rig.host.onEvent((e) => events.push(e))
  rig.host.onState((s) => states.push(s))
  const st = await rig.host.open('n1', 'w1', url)
  return { events, states, st }
}

describe('open', () => {
  it('runs connection setup then createTarget -> attach -> Page.enable -> metrics -> navigate', async () => {
    const { st } = await openLive()
    expect(st).toMatchObject({ id: 'n1', url: 'https://example.com/', live: 'live', lease: 'human' })
    const m = rig.fake.methods()
    const order = [CDP.setDiscoverTargets, CDP.setDownloadBehavior, CDP.createTarget, CDP.attachToTarget, CDP.pageEnable, CDP.setDeviceMetrics, CDP.navigate]
    expect(order.map((x) => m.indexOf(x))).toEqual([...order.map((x) => m.indexOf(x))].sort((a, b) => a - b))
    expect(order.every((x) => m.includes(x))).toBe(true)
    expect(callsOf(CDP.attachToTarget)[0].params).toMatchObject({ targetId: 'T1', flatten: true })
    expect(callsOf(CDP.pageEnable)[0].sessionId).toBe(SID)
    expect(callsOf(CDP.navigate)[0]).toMatchObject({ params: { url: 'https://example.com/' }, sessionId: SID })
  })

  it('denies downloads and every device permission once per connection', async () => {
    await openLive()
    expect(callsOf(CDP.setDownloadBehavior)[0].params).toMatchObject({ behavior: 'deny' })
    expect(callsOf(CDP.setPermission).map((c) => (c.params.permission as { name: string }).name)).toEqual([...DENIED_PERMISSIONS])
    expect(callsOf(CDP.setPermission).every((c) => c.params.setting === 'denied')).toBe(true)
    await rig.host.open('n2', 'w1', 'https://example.org/') // koneksi workspace yang sama dipakai ulang
    expect(callsOf(CDP.setDownloadBehavior)).toHaveLength(1)
    expect(callsOf(CDP.createTarget)).toHaveLength(2)
  })

  it('concurrent opens of one node create a single target', async () => {
    rig = await makeHostRig()
    const [a, b] = await Promise.all([rig.host.open('n1', 'w1', 'https://example.com/'), rig.host.open('n1', 'w1', 'https://example.com/')])
    expect(a).toEqual(b)
    expect(callsOf(CDP.createTarget)).toHaveLength(1)
  })

  it('does not navigate to a blocked url and records the reason', async () => {
    const { st } = await openLive('https://evil.test/')
    expect(st.blocked).toBe('private_host')
    expect(callsOf(CDP.navigate)).toHaveLength(0)
  })

  it('maps a missing browser binary to BrowserError no_binary and marks the node', async () => {
    rig = await makeHostRig()
    const host = new BrowserHost({ guard: stubGuard(), launcher: { acquire: async () => { throw new LaunchError('no_binary', 'none') }, shutdown: () => undefined } })
    await expect(host.open('n9', 'w1', 'https://example.com/')).rejects.toMatchObject({ name: 'BrowserError', code: 'no_binary' })
    expect(host.state('n9')?.blocked).toBe('no_binary')
  })

  it('retries the connection on the next open after a launcher failure', async () => {
    rig = await makeHostRig()
    let n = 0
    const host = new BrowserHost({ guard: stubGuard(), launcher: { acquire: async () => { if (++n === 1) throw new Error('boom'); return rig.fake.url }, shutdown: () => undefined } })
    await expect(host.open('n1', 'w1')).rejects.toBeInstanceOf(BrowserError)
    await expect(host.open('n1', 'w1')).resolves.toMatchObject({ live: 'live' })
    await host.dispose()
  })
})

describe('navigation', () => {
  it('navigate throws BlockedError (hostname only) and sends nothing', async () => {
    await openLive()
    const before = callsOf(CDP.navigate).length
    const err = await rig.host.navigate('n1', 'http://evil.test/secret?token=abc').catch((e: Error) => e)
    expect(err).toBeInstanceOf(BlockedError)
    expect((err as BlockedError).reason).toBe('private_host')
    expect((err as Error).message).not.toMatch(/token|secret/)
    expect(callsOf(CDP.navigate)).toHaveLength(before)
    expect(rig.host.state('n1')?.blocked).toBe('private_host')
  })

  it('blocks non-http schemes through the shared url parser', async () => {
    await openLive()
    await expect(rig.host.navigate('n1', 'file:///etc/passwd')).rejects.toMatchObject({ reason: 'scheme' })
  })

  it('a main-frame navigation the guard rejects is sent back to about:blank', async () => {
    const { states } = await openLive()
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'f', url: 'http://evil.test/redir' } }, SID)
    await waitFor(() => callsOf(CDP.navigate).some((c) => c.params.url === 'about:blank'), 'about:blank navigation')
    expect(rig.host.state('n1')?.blocked).toBe('private_host')
    expect(states.at(-1)?.blocked).toBe('private_host')
  })

  it('updates url and clears block on an allowed navigation; ignores subframes and about:', async () => {
    await openLive()
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'c', parentId: 'f', url: 'http://evil.test/' } }, SID)
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'f', url: 'about:blank' } }, SID)
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'f', url: 'https://example.net/next' } }, SID)
    await waitFor(() => rig.host.state('n1')?.url === 'https://example.net/next', 'url update')
    expect(rig.guard.navigated).toEqual(['https://example.net/next'])
    expect(rig.host.state('n1')?.blocked).toBeUndefined()
  })

  it('tracks loading and history (title/back/forward)', async () => {
    await openLive()
    rig.fake.handle(CDP.getNavigationHistory, () => ({ currentIndex: 1, entries: [{ id: 1, title: 'a' }, { id: 2, title: 'Now' }, { id: 3, title: 'c' }] }))
    rig.fake.emit(CDP_EVENT.frameStartedLoading, {}, SID)
    await waitFor(() => rig.host.isLoading('n1'), 'loading on')
    rig.fake.emit(CDP_EVENT.frameStoppedLoading, {}, SID)
    await waitFor(() => rig.host.state('n1')?.title === 'Now', 'history refresh')
    expect(rig.host.state('n1')).toMatchObject({ loading: false, canBack: true, canForward: true })
  })

  it('back/forward/reload/stop map to the right CDP calls', async () => {
    await openLive()
    rig.fake.handle(CDP.getNavigationHistory, () => ({ currentIndex: 1, entries: [{ id: 10, title: '' }, { id: 20, title: '' }, { id: 30, title: '' }] }))
    await rig.host.navAction('n1', 'back')
    await rig.host.navAction('n1', 'forward')
    await rig.host.navAction('n1', 'reload')
    await rig.host.navAction('n1', 'stop')
    expect(callsOf(CDP.navigateToHistoryEntry).map((c) => c.params.entryId)).toEqual([10, 30])
    expect(callsOf(CDP.reload)).toHaveLength(1)
    expect(callsOf(CDP.stopLoading)).toHaveLength(1)
    await expect(rig.host.navAction('n1', 'go')).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('a popup (window.open) is closed and its url opened in the opener node', async () => {
    await openLive()
    const info = { targetId: 'P1', type: 'page', title: '', url: 'https://pop.example/x', openerId: 'T1' }
    rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: info })
    await waitFor(() => callsOf(CDP.navigate).some((c) => c.params.url === 'https://pop.example/x'), 'popup navigation')
    expect(callsOf(CDP.closeTarget)[0].params).toEqual({ targetId: 'P1' })
    expect(callsOf(CDP.createTarget)).toHaveLength(1) // tidak ada node baru
  })

  it('a popup that gets its url later is handled on targetInfoChanged', async () => {
    await openLive()
    const base = { targetId: 'P2', type: 'page', title: '', openerId: 'T1' }
    rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: { ...base, url: '' } })
    rig.fake.emit(CDP_EVENT.targetInfoChanged, { targetInfo: { ...base, url: 'https://late.example/' } })
    await waitFor(() => callsOf(CDP.navigate).some((c) => c.params.url === 'https://late.example/'), 'late popup navigation')
  })
})

describe('screencast', () => {
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

  it('starts JPEG screencast and numbers frames with our own seq', async () => {
    await openLive()
    const frames: Frame[] = []
    await rig.host.startScreencast('n1', (f) => frames.push(f))
    expect(callsOf(CDP.startScreencast)[0]).toMatchObject({ sessionId: SID, params: { format: 'jpeg' } })
    rig.fake.emit(CDP_EVENT.screencastFrame, { data: jpegB64, sessionId: 77, metadata: {} }, SID)
    rig.fake.emit(CDP_EVENT.screencastFrame, { data: jpegB64, sessionId: 78, metadata: {} }, SID)
    await waitFor(() => frames.length === 2, 'two frames')
    expect(frames.map((f) => f.seq)).toEqual([1, 2])
    expect([...frames[0].jpeg]).toEqual([0xff, 0xd8, 0xff, 0xd9])
  })

  it('forwards the Chromium ack only after ackFrame(seq), once, and ignores unknown seq', async () => {
    await openLive()
    const frames: Frame[] = []
    await rig.host.startScreencast('n1', (f) => frames.push(f))
    rig.fake.emit(CDP_EVENT.screencastFrame, { data: jpegB64, sessionId: 77 }, SID)
    await waitFor(() => frames.length === 1, 'frame')
    expect(callsOf(CDP.screencastFrameAck)).toHaveLength(0) // belum di-ack klien
    rig.host.ackFrame('n1', 999) // seq asing
    rig.host.ackFrame('n1', frames[0].seq)
    rig.host.ackFrame('n1', frames[0].seq) // ganda
    await waitFor(() => callsOf(CDP.screencastFrameAck).length >= 1, 'ack')
    expect(callsOf(CDP.screencastFrameAck)).toHaveLength(1)
    expect(callsOf(CDP.screencastFrameAck)[0]).toMatchObject({ params: { sessionId: 77 }, sessionId: SID })
  })

  it('stopScreencast stops delivery and sends Page.stopScreencast', async () => {
    await openLive()
    const frames: Frame[] = []
    await rig.host.startScreencast('n1', (f) => frames.push(f))
    await rig.host.stopScreencast('n1')
    rig.fake.emit(CDP_EVENT.screencastFrame, { data: jpegB64, sessionId: 1 }, SID)
    await waitFor(() => callsOf(CDP.stopScreencast).length === 1, 'stop')
    await new Promise((r) => setTimeout(r, 30))
    expect(frames).toHaveLength(0)
  })

  it('seq wraps as uint32', () => {
    const rec = newRec('n', 'w', '')
    const got: number[] = []
    rec.cast = { onFrame: (f) => got.push(f.seq), seq: 0xffffffff, acks: new Map() }
    pushFrame(rec, { data: '', sessionId: 1 })
    expect(got).toEqual([0])
  })
})

describe('lifecycle and extras', () => {
  it('a crashed target becomes discarded and raises a crashed error event', async () => {
    const { events } = await openLive()
    rig.fake.emit(CDP_EVENT.targetCrashed, { targetId: 'T1' })
    await waitFor(() => events.length === 1, 'crash event')
    expect(events[0]).toEqual({ k: 'error', nodeId: 'n1', code: 'crashed' })
    expect(rig.host.state('n1')?.live).toBe('discarded')
    await expect(rig.host.input('n1', { t: 'text', text: 'x' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a dropped CDP socket marks all nodes of that workspace as crashed', async () => {
    const { events } = await openLive()
    rig.fake.drop()
    await waitFor(() => events.some((e) => e.k === 'error'), 'conn drop')
    expect(rig.host.state('n1')?.live).toBe('discarded')
  })

  it('discard closes the target without raising a crash and allows reopening', async () => {
    const { events } = await openLive()
    await rig.host.discard('n1')
    expect(rig.host.state('n1')?.live).toBe('discarded')
    expect(callsOf(CDP.closeTarget)[0].params).toEqual({ targetId: 'T1' })
    rig.fake.emit(CDP_EVENT.targetDestroyed, { targetId: 'T1' })
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toHaveLength(0)
    expect(await rig.host.open('n1', 'w1')).toMatchObject({ live: 'live' })
  })

  it('dialog events are surfaced and can be answered', async () => {
    const { events } = await openLive()
    rig.fake.emit(CDP_EVENT.dialogOpening, { type: 'prompt', message: 'name?', defaultPrompt: 'bob' }, SID)
    await waitFor(() => events.length === 1, 'dialog event')
    expect(events[0]).toEqual({ k: 'dialog', nodeId: 'n1', kind: 'prompt', message: 'name?', defaultPrompt: 'bob' })
    await rig.host.answerDialog('n1', true, 'alice')
    expect(callsOf(CDP.handleDialog)[0].params).toEqual({ accept: true, promptText: 'alice' })
  })

  it('setViewport clamps dpr and rounds size', async () => {
    await openLive()
    await rig.host.setViewport('n1', 640.4, 480.6, 9)
    const last = callsOf(CDP.setDeviceMetrics).at(-1)
    expect(last?.params).toMatchObject({ width: 640, height: 481, deviceScaleFactor: DSF_MAX })
  })

  it('input dispatches CDP commands and enables touch emulation once', async () => {
    await openLive()
    await rig.host.input('n1', { t: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'a', vk: 65, mods: 0 })
    expect(callsOf(CDP.key).map((c) => c.params.type)).toEqual(['rawKeyDown', 'char'])
    const touch: BrowserInputEvent = { t: 'touch', type: 'start', points: [{ x: 1, y: 1, id: 1 }] }
    await rig.host.input('n1', touch)
    await rig.host.input('n1', touch)
    expect(callsOf(CDP.setTouchEmulation)).toHaveLength(1)
    expect(callsOf(CDP.touch)).toHaveLength(2)
  })

  it('input on a node that was never opened is a not_found BrowserError', async () => {
    rig = await makeHostRig()
    await expect(rig.host.input('ghost', { t: 'text', text: 'x' })).rejects.toBeInstanceOf(BrowserError)
  })

  it('selectionText reads the page selection and returns "" for non-strings', async () => {
    await openLive()
    rig.fake.handle(CDP.evaluate, () => ({ result: { value: 'pilihan' } }))
    expect(await rig.host.selectionText('n1')).toBe('pilihan')
    rig.fake.handle(CDP.evaluate, () => ({ result: {} }))
    expect(await rig.host.selectionText('n1')).toBe('')
  })

  it('a throwing state listener does not break the host', async () => {
    rig = await makeHostRig()
    rig.host.onState(() => { throw new Error('listener bug') })
    await expect(rig.host.open('n1', 'w1', 'https://example.com/')).resolves.toMatchObject({ live: 'live' })
  })
})
