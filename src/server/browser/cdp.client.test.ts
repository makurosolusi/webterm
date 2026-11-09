import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CDP, CdpClient, CdpClosedError, CdpCommandError, ignoreClosed, isTargetGone } from './cdp.client'
import { logBus } from '../logs'
import { SILENT, startFakeCdp, waitFor } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

let fake: FakeCdp
let client: CdpClient
afterEach(async () => { client?.close(); await fake?.close() })
async function setup(timeoutMs?: number) {
  fake = await startFakeCdp()
  client = await CdpClient.connect(fake.url, timeoutMs)
}

describe('CdpClient', () => {
  it('correlates responses to ids even when replies arrive out of order', async () => {
    await setup()
    fake.handle('Slow.m', async () => { await new Promise((r) => setTimeout(r, 40)); return { v: 'slow' } })
    fake.handle('Fast.m', () => ({ v: 'fast' }))
    const [slow, fast] = await Promise.all([client.send('Slow.m'), client.send('Fast.m')])
    expect(slow).toEqual({ v: 'slow' })
    expect(fast).toEqual({ v: 'fast' })
  })

  it('sends params and sessionId on the wire', async () => {
    await setup()
    await client.send('A.b', { x: 1 }, 'sess-9')
    expect(fake.calls[0]).toMatchObject({ method: 'A.b', params: { x: 1 }, sessionId: 'sess-9' })
  })

  it('delivers events to named and wildcard listeners with sessionId, and unsubscribes', async () => {
    await setup()
    const named: unknown[] = []
    const all: string[] = []
    const off = client.on('Page.x', (p, sid) => named.push([p, sid]))
    client.on('*', (_p, _s, m) => all.push(m))
    fake.emit('Page.x', { a: 1 }, 'S1')
    await waitFor(() => named.length === 1, 'first event')
    expect(named[0]).toEqual([{ a: 1 }, 'S1'])
    off()
    fake.emit('Page.x', { a: 2 })
    await waitFor(() => all.length === 2, 'second event')
    expect(named).toHaveLength(1)
  })

  it('turns a CDP error into an Error naming method and id', async () => {
    await setup()
    fake.handle('Bad.call', () => ({ __error: { code: -32000, message: 'No target' } }))
    const err = await client.send('Bad.call').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Bad\.call \(#\d+\) failed: No target \(code -32000\)/)
    expect(err).toBeInstanceOf(CdpCommandError)
    expect(err).toMatchObject({ method: 'Bad.call', code: -32000, cdpMessage: 'No target' })
  })

  it('isTargetGone recognises only CDP replies that mean the page target/session is gone', () => {
    const reply = (code: number, msg: string) => new CdpCommandError(`cdp X (#1) failed: ${msg} (code ${code})`, 'X', code, msg)
    const table: Array<[unknown, boolean]> = [
      [reply(-32000, 'Not attached to an active page'), true],
      [reply(-32000, 'Session with given id not found.'), true],
      [reply(-32000, 'No target with given id found'), true],
      [reply(-32000, 'Target closed'), true],
      [reply(-32000, 'Cannot navigate to invalid URL'), false],
      [reply(-32601, 'Not attached to an active page'), false],
      [new CdpClosedError('cdp X (#1) aborted: cdp closed by client'), false],
      [new Error('Not attached to an active page'), false],
    ]
    for (const [err, gone] of table) expect(isTargetGone(err), String((err as Error).message)).toBe(gone)
  })

  it('times out with method and id in the message', async () => {
    await setup(40)
    fake.handle('Hang.m', () => SILENT)
    await expect(client.send('Hang.m')).rejects.toThrow(/Hang\.m \(#\d+\) timed out after 40 ms/)
  })

  it('rejects every pending call with context when the socket drops, and refuses later sends', async () => {
    await setup()
    fake.handle('Hang.a', () => SILENT)
    fake.handle('Hang.b', () => SILENT)
    let closedWith: Error | undefined
    client.onClose((e) => { closedWith = e })
    const a = client.send('Hang.a').catch((e: Error) => e)
    const b = client.send('Hang.b').catch((e: Error) => e)
    await waitFor(() => fake.calls.length === 2, 'both calls received')
    fake.drop()
    expect(((await a) as Error).message).toMatch(/Hang\.a \(#\d+\) aborted: cdp socket closed/)
    expect(((await b) as Error).message).toMatch(/Hang\.b \(#\d+\) aborted/)
    expect(closedWith?.message).toMatch(/socket closed/)
    await expect(client.send('After.close')).rejects.toThrow(/After\.close \(#\d+\) not sent/)
    expect(client.closed).toBe(true)
  })

  it('connect rejects with context when nothing listens', async () => {
    await expect(CdpClient.connect('ws://127.0.0.1:1/devtools')).rejects.toThrow(/cdp connect failed/)
  })
})

describe('ignoreClosed (fire-and-forget sends)', () => {
  const fireLogs = () => logBus.snapshot().filter((e) => e.event === 'cdp.fire')

  it('drops a pending send aborted by close(): no unhandled rejection, no log', async () => {
    await setup()
    logBus.clear()
    const unhandled: unknown[] = []
    const onUnhandled = (r: unknown) => { unhandled.push(r) }
    process.on('unhandledRejection', onUnhandled)
    try {
      fake.handle(CDP.screencastFrameAck, () => SILENT)
      client.send(CDP.screencastFrameAck, { sessionId: 1 }, 'S1').catch(ignoreClosed(CDP.screencastFrameAck, { sessionId: 'S1' }))
      await waitFor(() => fake.calls.length === 1, 'ack received')
      client.close()
      client.send(CDP.screencastFrameAck, { sessionId: 2 }, 'S1').catch(ignoreClosed(CDP.screencastFrameAck)) // after close: not sent
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
      expect(fireLogs()).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('logs any other failure with method, ids and cause', async () => {
    logBus.clear()
    ignoreClosed(CDP.screencastFrameAck, { sessionId: 'S1' })(new Error('cdp Page.screencastFrameAck (#3) send failed: EPIPE', { cause: new Error('EPIPE') }))
    const entry = fireLogs()[0]
    expect(entry?.ids).toMatchObject({ sessionId: 'S1' })
    expect(entry?.data).toMatchObject({ method: CDP.screencastFrameAck, error: expect.stringContaining('send failed'), cause: 'EPIPE' })
  })

  it('logs a CDP error reply on a live connection', async () => {
    await setup()
    logBus.clear()
    fake.handle(CDP.screencastFrameAck, () => ({ __error: { code: -32000, message: 'No session' } }))
    client.send(CDP.screencastFrameAck, {}, 'S1').catch(ignoreClosed(CDP.screencastFrameAck))
    await waitFor(() => fireLogs().length === 1, 'warn logged')
    expect(fireLogs()[0]?.data).toMatchObject({ method: CDP.screencastFrameAck, error: expect.stringContaining('No session') })
  })
})

describe('CDP method table', () => {
  it('is the only place that spells CDP methods in production sources of src/server/browser', () => {
    const dir = __dirname
    const literal = /['"](?:Target|Page|Input|Emulation|Browser|Runtime|Inspector)\.[a-zA-Z]+['"]/
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts') && f !== 'cdp.client.ts')
      .filter((f) => literal.test(readFileSync(join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
    expect(CDP.startScreencast).toBe('Page.startScreencast')
  })
})
