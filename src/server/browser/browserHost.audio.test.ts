// Audio capture end to end on the fake CDP server: host setup, listener gating, focus rule, OOPIF ordering, lifecycle, and the hub's per-listener lanes.
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIO_BINDING } from '../../shared/browser.contract'
import type { LeaseView } from '../../shared/browser.contract'
import { decodeAudioFrame } from '../../shared/browser.wire'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'
import { createViewerHub } from './browserWs.viewers'
import type { GatewayHost, Viewer, ViewerSink } from './browserWs.viewers'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const SID = 'S-T1'
const callsOf = (m: string) => rig.fake.calls.filter((c) => c.method === m)
const leases: LeaseView = { holder: () => 'human', noteHumanInput: () => undefined, takeover: () => undefined }
const b64 = (s: string) => Buffer.from(s).toString('base64')
/** A CDP round trip on the same socket: every event emitted before it has been handled when it returns. */
const settle = () => rig.host.cdp('n1', CDP.evaluate, { expression: '1' })
const binding = async (payload: string, sid = SID) => { rig.fake.emit(CDP_EVENT.bindingCalled, { name: AUDIO_BINDING, payload }, sid); await settle() }
const chunk = (f: string, s: number, text = 'x', sid = SID) => binding(JSON.stringify({ k: 'c', f, s, d: b64(text) }), sid)
const bus = (f: string, sid = SID) => binding(JSON.stringify({ k: 'b', f }), sid)
const audioScripts = () => callsOf(CDP.addScript).filter((c) => String(c.params.source).includes(AUDIO_BINDING))
const evals = (fn: string) => callsOf(CDP.evaluate).filter((c) => String(c.params.expression).includes(fn))

async function open(audio = true) {
  rig = await makeHostRig(stubGuard(), { audio: () => audio })
  await rig.host.open('n1', 'w1', 'https://a.test/')
}

function viewer() {
  const frames: Uint8Array[] = []
  const sink: ViewerSink = { bufferedAmount: 0, sendBinary: (b, done) => { frames.push(b); done?.(); return true }, sendJson: () => undefined }
  const v: Viewer = { sink }
  return { v, frames, audio: () => frames.map((f) => decodeAudioFrame(f)).filter((x) => x !== null) }
}
const hubOf = () => createViewerHub(rig.host as unknown as GatewayHost, leases)

describe('page setup', () => {
  it('installs the binding then the script on the page, and enables iframe auto-attach without a shield policy', async () => {
    await open()
    expect(callsOf(CDP.addBinding).some((c) => c.params.name === AUDIO_BINDING && c.sessionId === SID)).toBe(true)
    expect(audioScripts()).toHaveLength(1)
    expect(callsOf(CDP.addBinding)[0].id).toBeLessThan(audioScripts()[0].id)
    expect(callsOf(CDP.setAutoAttach).length).toBeGreaterThan(0)
  })

  it('kill switch off: nothing audio is installed and auto-attach stays off', async () => {
    await open(false)
    expect(callsOf(CDP.addBinding)).toHaveLength(0)
    expect(audioScripts()).toHaveLength(0)
    expect(callsOf(CDP.setAutoAttach)).toHaveLength(0)
  })
})

describe('lazy Runtime.enable (anti-bot signal)', () => {
  it('is not sent before audio on, and sent once for the page after it', async () => {
    await open()
    expect(callsOf(CDP.runtimeEnable)).toHaveLength(0)
    const hub = hubOf(); const a = viewer(); const b = viewer(); hub.join('n1', a.v); hub.join('n1', b.v)
    await settle()
    expect(callsOf(CDP.runtimeEnable)).toHaveLength(0)
    hub.setAudio('n1', a.v, true)
    await waitFor(() => evals('__wtAudioResume').length === 1, 'resume sent')
    expect(callsOf(CDP.runtimeEnable).filter((c) => c.sessionId === SID)).toHaveLength(1)
    hub.setAudio('n1', a.v, false); hub.setAudio('n1', b.v, true)
    await waitFor(() => evals('__wtAudioResume').length === 2, 'second resume')
    expect(callsOf(CDP.runtimeEnable).filter((c) => c.sessionId === SID)).toHaveLength(1)
  })
})

describe('listening gate', () => {
  it('no frame reaches a client that never said audio on; capture is resumed only while someone listens', async () => {
    await open()
    const hub = hubOf()
    const a = viewer(), b = viewer()
    hub.join('n1', a.v); hub.join('n1', b.v)
    await chunk('k1', 0)
    expect(a.frames).toHaveLength(0)
    hub.setAudio('n1', a.v, true)
    await waitFor(() => evals('__wtAudioResume').length === 1, 'resume sent')
    // The speaker click lives in the client: the page needs a user activation from us or its suspended bus stays silent.
    expect(evals('__wtAudioResume')[0]!.params.userGesture).toBe(true)
    await chunk('k1', 1, 'hello')
    expect(a.audio().map((c) => [c.streamKey, c.seq, Buffer.from(c.payload).toString()])).toEqual([['k1', 1, 'hello']])
    expect(b.frames).toHaveLength(0)
    hub.setAudio('n1', a.v, false)
    await waitFor(() => evals('__wtAudioPause').length === 1, 'pause sent')
    expect(evals('__wtAudioPause')[0]!.params.userGesture).toBe(false)
    await chunk('k1', 2)
    expect(a.audio()).toHaveLength(1)
  })

  it('a listener that leaves stops capture; a later listener gets the init segment first', async () => {
    await open()
    const hub = hubOf()
    const a = viewer(), b = viewer()
    hub.join('n1', a.v); hub.join('n1', b.v)
    hub.setAudio('n1', a.v, true)
    await waitFor(() => evals('__wtAudioResume').length === 1, 'first resume')
    await chunk('k1', 0, 'HEAD'); await chunk('k1', 1, 'body')
    hub.setAudio('n1', b.v, true)
    expect(evals('__wtAudioResume')).toHaveLength(1) // second listener does not restart capture
    expect(b.audio().map((c) => [c.seq, Buffer.from(c.payload).toString()])).toEqual([[0, 'HEAD']])
    await hub.leave('n1', a.v); await hub.leave('n1', b.v)
    await waitFor(() => evals('__wtAudioPause').length === 1, 'pause after last listener left')
  })

  it('oversized or malformed chunks are dropped', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    await chunk('BAD KEY', 0)
    await binding('not json')
    await binding(JSON.stringify({ k: 'c', f: 'k', s: 0, d: 'A'.repeat(400_000) }))
    expect(a.frames).toHaveLength(0)
  })
})

describe('state and lifecycle', () => {
  it('audioActive is true once a listened page created a bus, cleared by main-frame navigation', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    expect(rig.host.state('n1')?.audioActive).toBeUndefined()
    await bus('f1')
    await waitFor(() => rig.host.state('n1')?.audioActive === true, 'active')
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { url: 'https://a.test/2' } }, SID)
    await settle()
    await waitFor(() => rig.host.state('n1')?.audioActive === undefined, 'cleared by navigation')
  })

  it('a bus created while someone listens is resumed at once (page reload / late source)', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    await waitFor(() => evals('__wtAudioResume').length === 1, 'first resume')
    await bus('f2')
    await waitFor(() => evals('__wtAudioResume').length === 2, 'resume on new bus')
  })

  it('a discarded node drops its streams, and stale chunks no longer reach listeners', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    await bus('f1')
    await waitFor(() => rig.host.state('n1')?.audioActive === true, 'active')
    await rig.host.discard('n1')
    expect(rig.host.state('n1')?.audioActive).toBeUndefined()
    rig.fake.emit(CDP_EVENT.bindingCalled, { name: AUDIO_BINDING, payload: JSON.stringify({ k: 'c', f: 'k1', s: 1, d: b64('x') }) }, SID)
    await new Promise((r) => setTimeout(r, 50)) // no CDP round trip possible: the node has no page any more
    expect(a.frames).toHaveLength(0)
  })

  it('only the focused tab is streamed: chunks of a background tab session are muted', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    const table = (rig.host as unknown as { table: { bgBind(r: unknown, t: string, tg: string, s: string): void; nodes: Map<string, unknown> } }).table
    const cdp = (rig.host as unknown as { life: { cdpOf(r: unknown): Promise<import('./cdp.client').CdpClient> } }).life
    await rig.host.audio.enable(await cdp.cdpOf(table.nodes.get('n1')), 'S-bg')
    table.bgBind(table.nodes.get('n1'), 'tab2', 'T9', 'S-bg')
    await chunk('kbg', 0, 'bg', 'S-bg')
    expect(a.frames).toHaveLength(0)
    await chunk('kfg', 0, 'fg')
    expect(a.audio().map((c) => c.streamKey)).toEqual(['kfg'])
  })
})

describe('OOPIF', () => {
  it('the child is released only after binding and script are installed in it', async () => {
    await open()
    rig.fake.emit(CDP_EVENT.attachedToTarget, { sessionId: 'S-child', waitingForDebugger: true, targetInfo: { type: 'iframe', targetId: 'F1' } }, SID)
    await waitFor(() => callsOf(CDP.runIfWaiting).some((c) => c.sessionId === 'S-child'), 'child released')
    const forChild = rig.fake.calls.filter((c) => c.sessionId === 'S-child').map((c) => c.method)
    expect(forChild.indexOf(CDP.addScript)).toBeGreaterThan(-1)
    expect(forChild.indexOf(CDP.runIfWaiting)).toBeGreaterThan(forChild.indexOf(CDP.addScript))
    expect(forChild).toContain(CDP.pageEnable)
    expect(forChild).toContain(CDP.addBinding)
  })

  it('a chunk from the child session reaches the node listeners', async () => {
    await open()
    const hub = hubOf(); const a = viewer(); hub.join('n1', a.v); hub.setAudio('n1', a.v, true)
    rig.fake.emit(CDP_EVENT.attachedToTarget, { sessionId: 'S-child', waitingForDebugger: true, targetInfo: { type: 'iframe', targetId: 'F1' } }, SID)
    await waitFor(() => callsOf(CDP.runIfWaiting).some((c) => c.sessionId === 'S-child'), 'child ready')
    await chunk('kc', 0, 'ch', 'S-child')
    expect(a.audio().map((c) => c.streamKey)).toEqual(['kc'])
  })
})
