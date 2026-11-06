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
import { logBus } from '../logs'

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

  it('acks the host on receipt and holds only the newest frame while the client is at maxInFlight', async () => {
    rig = await makeRig()
    const c = await attached()
    for (let s = 1; s <= MAX_FRAMES_IN_FLIGHT + 3; s++) rig.host.emitFrame('n1', s)
    expect(rig.host.acks.map(([, s]) => s)).toEqual([1, 2, 3, 4, 5]) // tiap frame di-ack saat diterima
    await wait(() => c.bin.length === MAX_FRAMES_IN_FLIGHT, 'two frames')
    await settle()
    expect(c.bin).toHaveLength(MAX_FRAMES_IN_FLIGHT)
    c.send({ t: 'ack', id: 'n1', seq: 1 })
    await wait(() => c.bin.length === 3, 'pending frame after client ack')
    expect(decodeFrameHeader(c.bin[2])?.seq).toBe(5) // frame 3 & 4 ditimpa frame terbaru
    c.send({ t: 'ack', id: 'n1', seq: 2 })
    await settle()
    expect(c.bin).toHaveLength(3) // tidak ada frame basi yang menyusul
  })

  it('a slow viewer does not hold back a fast one', async () => {
    rig = await makeRig()
    const a = await attached(), b = await attached()
    for (let s = 1; s <= 3; s++) rig.host.emitFrame('n1', s)
    await wait(() => a.bin.length === 2 && b.bin.length === 2, 'both got two')
    a.send({ t: 'ack', id: 'n1', seq: 1 })
    await wait(() => a.bin.length === 3, 'fast viewer got the pending frame')
    expect(b.bin).toHaveLength(2)
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

  it('a click is not stuck behind a wheel the host has not finished', async () => {
    rig = await makeRig()
    const c = await attached()
    rig.host.hold.wheel = new Promise(() => undefined) // wheel yang tak pernah selesai
    c.send({ t: 'mouse', id: 'n1', type: 'wheel', x: 1, y: 1, button: 'none', buttons: 0, clickCount: 0, mods: 0, dx: 0, dy: 50 })
    c.send({ t: 'mouse', id: 'n1', type: 'down', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1, mods: 0 })
    await wait(() => rig.host.inputs.length === 1, 'click reached host')
    expect(rig.host.inputs[0]).toMatchObject({ t: 'mouse', type: 'down' })
  })

  it('input never overtakes a pending attach', async () => {
    rig = await makeRig()
    let release!: () => void
    rig.host.hold.open = new Promise((r) => { release = r })
    const c = await rig.connect()
    c.send(attach())
    c.send({ t: 'text', id: 'n1', text: 'x' })
    await settle()
    expect(rig.host.inputs).toEqual([])
    release()
    await wait(() => rig.host.inputs.length === 1, 'input after attach')
    expect(rig.host.viewports).toHaveLength(1)
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

  it('logs the message and cause of an unexpected attach failure but sends the client only the code', async () => {
    rig = await makeRig()
    logBus.clear()
    rig.host.fail.open = new Error('cdp connect timed out after 10000 ms', { cause: new Error('ECONNREFUSED 127.0.0.1:9222') })
    const c = await rig.connect()
    c.send(attach())
    await wait(() => c.json.length === 1, 'error')
    expect(c.json[0]).toEqual({ t: 'error', id: 'n1', code: 'crashed' })
    const entry = logBus.snapshot().find((e) => e.event === 'browser.ws' && e.message === 'unexpected gateway failure')
    expect(entry?.ids).toMatchObject({ nodeId: 'n1' })
    expect(entry?.data).toMatchObject({ error: 'cdp connect timed out after 10000 ms', name: 'Error', cause: 'ECONNREFUSED 127.0.0.1:9222' })
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
    await waitCdp(() => h.fake.methods().includes('Page.screencastFrameAck'), 'host ack on receipt (before any client ack)')
    expect(h.fake.calls.find((c) => c.method === 'Page.startScreencast')?.params).toMatchObject({ maxWidth: 800, maxHeight: 600 })
    expect(h.fake.calls.find((c) => c.method === 'Page.screencastFrameAck')?.params).toEqual({ sessionId: 77 })
    ws.terminate()
    await waitCdp(() => h.fake.methods().includes('Page.stopScreencast'), 'stopScreencast on disconnect')
    await new Promise<void>((r) => wss.close(() => r()))
    await h.stop()
    rig = undefined as unknown as Rig
  })
})
