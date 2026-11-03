import { afterEach, describe, expect, it } from 'vitest'
import { BlockedError, MAX_FRAMES_IN_FLIGHT } from '../../shared/browser.contract'
import { decodeFrameHeader } from '../../shared/browser.wire'
import { BrowserHost } from './browserHost.service'
import { BrowserError } from './browserHost.targets'
import { CDP_EVENT } from './cdp.client'
import { makeHostRig, waitFor as waitCdp } from './fakeCdp.testkit'
import { makeRig, stateOf } from './browserWs.testkit'
import type { Client, Rig } from './browserWs.testkit'
import { createViewerHub } from './browserWs.viewers'
import type { GatewayHost } from './browserWs.viewers'
import { handleBrowserConnection } from './browserWs.gateway'

let rig: Rig
afterEach(async () => { await rig?.stop() })
const wait = async (cond: () => boolean, what: string, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40))
const attach = (id = 'n1', over = {}) => ({ t: 'attach', id, w: 800, h: 600, dpr: 1, ...over })
async function attached(id = 'n1', c?: Client): Promise<Client> {
  const cl = c ?? (await rig.connect())
  const before = cl.json.length
  cl.send(attach(id))
  await wait(() => cl.json.length > before, 'state after attach')
  return cl
}

describe('viewers and screencast', () => {
  it('starts the screencast once for two viewers and stops only after the last leaves', async () => {
    rig = await makeRig()
    const a = await attached(), b = await attached()
    expect(rig.host.starts).toEqual(['n1'])
    expect(a.json[0]).toMatchObject({ t: 'state', id: 'n1', live: 'live', lease: 'human' })
    a.send({ t: 'detach', id: 'n1' })
    await settle()
    expect(rig.host.stops).toEqual([])
    b.send({ t: 'detach', id: 'n1' })
    await wait(() => rig.host.stops.length === 1, 'stop after last detach')
    expect(rig.hub.count('n1')).toBe(0)
  })

  it('stops the screencast and releases every host listener when the socket drops', async () => {
    rig = await makeRig()
    const c = await attached()
    expect(rig.host.stateCbs.size).toBe(1)
    expect(rig.host.eventCbs.size).toBe(1)
    c.ws.terminate()
    await wait(() => rig.host.stops.length === 1, 'stop on disconnect')
    expect(rig.hub.count('n1')).toBe(0)
    expect(rig.host.stateCbs.size).toBe(0)
    expect(rig.host.eventCbs.size).toBe(0)
  })

  it('withholds frame 3 until the client acks (maxInFlight) and acks the host only after the client acked', async () => {
    rig = await makeRig()
    const c = await attached()
    for (let s = 1; s <= MAX_FRAMES_IN_FLIGHT + 1; s++) rig.host.emitFrame('n1', s)
    await wait(() => c.bin.length === MAX_FRAMES_IN_FLIGHT, 'two frames')
    await settle()
    expect(c.bin).toHaveLength(MAX_FRAMES_IN_FLIGHT)
    expect(decodeFrameHeader(c.bin[0])).toMatchObject({ nodeId: 'n1', seq: 1 })
    expect(rig.host.acks).toEqual([['n1', 3]]) // frame yang dibuang tidak boleh menahan host
    c.send({ t: 'ack', id: 'n1', seq: 1 })
    await wait(() => rig.host.acks.length === 2, 'host ack after client ack')
    expect(rig.host.acks[1]).toEqual(['n1', 1])
    rig.host.emitFrame('n1', 4)
    await wait(() => c.bin.length === 3, 'frame after ack')
  })

  it('acks the host for a frame only after every viewer received-and-acked it', async () => {
    rig = await makeRig()
    const a = await attached(), b = await attached()
    rig.host.emitFrame('n1', 1)
    await wait(() => a.bin.length === 1 && b.bin.length === 1, 'both got frame')
    a.send({ t: 'ack', id: 'n1', seq: 1 })
    await settle()
    expect(rig.host.acks).toEqual([])
    b.ws.terminate() // viewer yang putus tidak boleh menahan ack selamanya
    await wait(() => rig.host.acks.length === 1, 'ack after slow viewer left')
    expect(rig.host.acks[0]).toEqual(['n1', 1])
  })

  it('ignores an ack for an unknown seq', async () => {
    rig = await makeRig()
    const c = await attached()
    c.send({ t: 'ack', id: 'n1', seq: 99 })
    await settle()
    expect(rig.host.acks).toEqual([])
  })

  it('restarts the screencast when the target comes back live after a crash', async () => {
    rig = await makeRig()
    await attached()
    rig.host.setState(stateOf('n1', { live: 'discarded' }))
    rig.host.setState(stateOf('n1', { live: 'live' }))
    await wait(() => rig.host.starts.length === 2, 'screencast restarted')
  })
})

describe('input, lease and errors', () => {
  it('answers a malformed or binary message with bad_request and keeps the socket usable', async () => {
    rig = await makeRig()
    const c = await rig.connect()
    c.send('{not json')
    c.send({ t: 'mouse', id: 'n1', type: 'down', x: Number.NaN })
    c.ws.send(new Uint8Array([1, 2, 3]))
    await wait(() => c.json.length === 3, 'three errors')
    expect(c.json.every((m) => m.t === 'error' && m.code === 'bad_request')).toBe(true)
    await attached('n1', c)
    expect(c.json[3]).toMatchObject({ t: 'state', id: 'n1' })
  })

  it('rejects input for a node this socket never attached', async () => {
    rig = await makeRig()
    const c = await rig.connect()
    c.send({ t: 'text', id: 'n1', text: 'x' })
    await wait(() => c.json.length === 1, 'error')
    expect(c.json[0]).toMatchObject({ t: 'error', id: 'n1', code: 'not_found' })
    expect(rig.host.inputs).toEqual([])
  })

  it('rejects human input while the agent holds the lease; takeover restores it', async () => {
    rig = await makeRig()
    const c = await attached()
    rig.leases.holders.set('n1', 'agent')
    c.send({ t: 'mouse', id: 'n1', type: 'down', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, mods: 0 })
    c.send({ t: 'nav', id: 'n1', action: 'reload' })
    await wait(() => c.json.length === 3, 'two lease errors')
    expect(c.json.slice(1).map((m) => m.code)).toEqual(['lease_agent', 'lease_agent'])
    expect(rig.host.inputs).toEqual([])
    expect(rig.host.navs).toEqual([])
    c.send({ t: 'takeover', id: 'n1' })
    await wait(() => c.json.some((m) => m.t === 'state' && c.json.indexOf(m) > 2), 'state after takeover')
    c.send({ t: 'text', id: 'n1', text: 'hi' })
    await wait(() => rig.host.inputs.length === 1, 'input after takeover')
    expect(rig.leases.noted).toEqual(['n1'])
  })

  it('forwards input in order and clamps dpr to DSF_MAX', async () => {
    rig = await makeRig()
    const c = await rig.connect()
    c.send(attach('n1', { dpr: 3 }))
    for (const type of ['down', 'move', 'up']) c.send({ t: 'mouse', id: 'n1', type, x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1, mods: 0 })
    await wait(() => rig.host.inputs.length === 3, 'three inputs')
    expect(rig.host.inputs.map((e) => (e.t === 'mouse' ? e.type : e.t))).toEqual(['down', 'move', 'up'])
    expect(rig.host.viewports[0]).toEqual(['n1', 800, 600, 2])
  })

  it('maps host failures to typed errors without leaking messages or killing the socket', async () => {
    rig = await makeRig()
    const c = await attached()
    rig.host.fail.nav = new BlockedError('private_host', 'evil.test')
    c.send({ t: 'nav', id: 'n1', action: 'go', url: 'http://evil.test/secret?token=1' })
    rig.host.fail.input = new Error('internal path /etc/secret')
    c.send({ t: 'text', id: 'n1', text: 'x' })
    await wait(() => c.json.length === 3, 'two errors')
    expect(c.json[1]).toEqual({ t: 'error', id: 'n1', code: 'blocked', hostname: 'evil.test' })
    expect(c.json[2]).toEqual({ t: 'error', id: 'n1', code: 'crashed' })
    expect(JSON.stringify(c.json)).not.toContain('secret')
    rig.host.fail = {}
    c.send({ t: 'text', id: 'n1', text: 'y' })
    await wait(() => rig.host.inputs.length === 1, 'socket still works')
  })

  it('maps an open failure (no_binary) to an error for that node', async () => {
    rig = await makeRig()
    rig.host.fail.open = new BrowserError('no_binary', 'no chromium')
    const c = await rig.connect()
    c.send(attach())
    await wait(() => c.json.length === 1, 'error')
    expect(c.json[0]).toMatchObject({ t: 'error', id: 'n1', code: 'no_binary' })
    expect(rig.hub.count('n1')).toBe(0)
  })

  it('relays dialog events and copy results to the node viewers', async () => {
    rig = await makeRig()
    const c = await attached()
    for (const cb of rig.host.eventCbs) cb({ k: 'dialog', nodeId: 'n1', kind: 'confirm', message: 'sure?' })
    c.send({ t: 'copy', id: 'n1' })
    await wait(() => c.json.length === 3, 'dialog + copy')
    expect(c.json[1]).toMatchObject({ t: 'dialog', id: 'n1', kind: 'confirm', message: 'sure?' })
    expect(c.json[2]).toEqual({ t: 'copy', id: 'n1', text: 'selected' })
  })

  it('broadcasts host state with the authoritative lease', async () => {
    rig = await makeRig()
    const a = await attached()
    rig.leases.holders.set('n1', 'agent')
    rig.host.setState(stateOf('n1', { loading: true }))
    await wait(() => a.json.length === 2, 'state broadcast')
    expect(a.json[1]).toMatchObject({ t: 'state', loading: true, lease: 'agent' })
  })
})

describe('feature flag', () => {
  it('closes the socket with an error when the flag is off at connect', async () => {
    rig = await makeRig()
    rig.flag.on = false
    const c = await rig.connect()
    expect(await c.closed).toBe(1008)
    expect(c.json[0]).toMatchObject({ t: 'error', code: 'disabled' })
    expect(rig.host.opens).toEqual([])
  })

  it('closes a live socket when the flag turns off mid-session', async () => {
    rig = await makeRig()
    const c = await attached()
    rig.flag.on = false
    c.send({ t: 'ack', id: 'n1', seq: 1 })
    expect(await c.closed).toBe(1008)
    await wait(() => rig.host.stops.length === 1, 'cleanup after flag off')
  })
})

describe('with the real BrowserHost over a fake CDP server', () => {
  it('streams a screencast frame and forwards the client ack as Page.screencastFrameAck', async () => {
    const h = await makeHostRig()
    const { WebSocketServer, WebSocket } = await import('ws')
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const host: GatewayHost = h.host // BrowserHost harus memenuhi GatewayHost secara struktural
    const leases = { holder: () => 'human' as const, noteHumanInput: () => undefined, takeover: () => undefined }
    const hub = createViewerHub(host, leases)
    wss.on('connection', (ws) => handleBrowserConnection(ws, { host, leases, hub, enabled: () => true, workspaceId: 'w1' }))
    const port = (wss.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const got: Uint8Array[] = []
    ws.on('message', (d, isBin) => { if (isBin) got.push(new Uint8Array(d as Buffer)) })
    await new Promise<void>((r) => ws.once('open', () => r()))
    ws.send(JSON.stringify(attach()))
    await waitCdp(() => h.fake.methods().includes('Page.startScreencast'), 'startScreencast')
    expect(h.host).toBeInstanceOf(BrowserHost)
    h.fake.emit(CDP_EVENT.screencastFrame, { data: Buffer.from([0xff, 0xd8]).toString('base64'), sessionId: 77 }, 'S-T1')
    await waitCdp(() => got.length === 1, 'frame at client')
    expect(h.fake.methods()).not.toContain('Page.screencastFrameAck') // belum di-ack klien
    ws.send(JSON.stringify({ t: 'ack', id: 'n1', seq: decodeFrameHeader(got[0])?.seq }))
    await waitCdp(() => h.fake.methods().includes('Page.screencastFrameAck'), 'host ack')
    expect(h.fake.calls.find((c) => c.method === 'Page.screencastFrameAck')?.params).toEqual({ sessionId: 77 })
    ws.terminate()
    await waitCdp(() => h.fake.methods().includes('Page.stopScreencast'), 'stopScreencast on disconnect')
    await new Promise<void>((r) => wss.close(() => r()))
    await h.stop()
    rig = undefined as unknown as Rig
  })
})
