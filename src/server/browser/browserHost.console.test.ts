import { afterEach, describe, expect, it } from 'vitest'
import { CONSOLE_BATCH_MAX, CONSOLE_BUFFER_MAX } from '../../shared/browser.console'
import type { ConsoleDelta } from '../../shared/browser.console'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const SID = 'S-T1' // test-only: session the fake CDP server gives the first target
const str = (value: string) => ({ type: 'string', value })
const log = (...args: object[]) => rig.fake.emit(CDP_EVENT.consoleApiCalled, { type: 'log', args, stackTrace: { callFrames: [{ functionName: 'f', url: 'https://a.test/js/app.js?v=1', lineNumber: 11, columnNumber: 4 }] } }, SID)
const mainNav = (url: string) => rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'T1', url } }, SID)

async function openLive() {
  rig = await makeHostRig()
  const deltas: ConsoleDelta[] = []
  rig.host.console.onDelta((d) => deltas.push(d))
  await rig.host.open('n1', 'w1', 'https://a.test/')
  return { deltas, read: () => rig.host.console.read('n1', CONSOLE_BUFFER_MAX, 'verbose') }
}

describe('console capture', () => {
  it('enables Runtime and Log on the page session', async () => {
    await openLive()
    for (const m of [CDP.runtimeEnable, CDP.logEnable]) expect(rig.fake.calls.find((c) => c.method === m)?.sessionId).toBe(SID)
  })

  it('captures console API calls, uncaught exceptions and browser log entries with level and source location', async () => {
    const { read } = await openLive()
    log(str('%s has %d items'), str('cart'), { type: 'number', value: 3, description: '3' })
    rig.fake.emit(CDP_EVENT.consoleApiCalled, { type: 'warning', args: [{ type: 'object', subtype: 'array', preview: { type: 'object', subtype: 'array', description: 'Array(2)', properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'string', value: 'x' }] } }] }, SID)
    rig.fake.emit(CDP_EVENT.exceptionThrown, { exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'TypeError: x is not a function\n    at f (app.js:3:1)' }, stackTrace: { callFrames: [{ functionName: '', url: 'https://a.test/app.js', lineNumber: 2, columnNumber: 0 }] } } }, SID)
    rig.fake.emit(CDP_EVENT.logEntryAdded, { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', url: 'https://a.test/missing.png' } }, SID)
    rig.fake.emit(CDP_EVENT.consoleApiCalled, { type: 'log', args: [str('from another session')] }, 'S-iframe') // not this page
    await waitFor(() => read().entries.length === 4, 'four entries')
    const [a, b, c, d] = read().entries
    expect(a).toMatchObject({ level: 'info', source: 'console', text: 'cart has 3 items', url: 'https://a.test/js/app.js?v=1', line: 12, col: 5 })
    expect(b).toMatchObject({ level: 'warning', text: 'Array(2) [1, \'x\']' })
    expect(c).toMatchObject({ level: 'error', source: 'exception', text: 'Uncaught TypeError: x is not a function', line: 3, stack: [{ fn: '(anonymous)', line: 3, col: 1 }] })
    expect(d).toMatchObject({ level: 'error', source: 'network', text: 'Failed to load resource: 404', url: 'https://a.test/missing.png' })
    expect(a.seq).toBeLessThan(d.seq)
  })

  it('caps the ring buffer at CONSOLE_BUFFER_MAX and counts drops', async () => {
    const { read } = await openLive()
    for (let i = 0; i < CONSOLE_BUFFER_MAX + 7; i++) log(str(`m${i}`))
    await waitFor(() => read().dropped === 7, 'seven dropped')
    const r = read()
    expect(r.entries).toHaveLength(CONSOLE_BUFFER_MAX)
    expect(r.entries[0].text).toBe('m7')
    expect(rig.host.console.read('n1', 3, 'info').entries.map((e) => e.text)).toEqual([`m${CONSOLE_BUFFER_MAX + 4}`, `m${CONSOLE_BUFFER_MAX + 5}`, `m${CONSOLE_BUFFER_MAX + 6}`])
  })

  it('clears on main-frame navigation by default; Preserve log keeps entries and adds a separator', async () => {
    const { read, deltas } = await openLive()
    log(str('before'))
    await waitFor(() => read().entries.length === 1, 'entry')
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'child', parentId: 'T1', url: 'https://ads.test/' } }, SID) // iframe: no clear
    mainNav('https://b.test/')
    await waitFor(() => read().entries.length === 0, 'cleared')
    await waitFor(() => deltas.some((d) => d.reset), 'reset delta')
    await rig.host.console.command({ t: 'console', id: 'n1', op: 'preserve', on: true })
    log(str('kept'))
    mainNav('https://c.test/')
    await waitFor(() => read().entries.length === 2, 'kept + separator')
    expect(read().entries.map((e) => [e.source, e.text])).toEqual([['console', 'kept'], ['system', 'Navigated to https://c.test/']])
    await waitFor(() => deltas.at(-1)?.preserve === true, 'preserve streamed')
  })

  it('batches a burst into few deltas of at most CONSOLE_BATCH_MAX entries', async () => {
    const { deltas, read } = await openLive()
    for (let i = 0; i < 300; i++) log(str(`b${i}`))
    await waitFor(() => read().entries.length === 300, 'all buffered')
    await waitFor(() => deltas.some((d) => d.entries.some((e) => e.text === 'b299')), 'last entry streamed')
    expect(deltas.length).toBeLessThanOrEqual(5)
    expect(deltas.every((d) => d.entries.length <= CONSOLE_BATCH_MAX)).toBe(true)
  })

  it('Clear empties the buffer, resets the drop count and releases eval objects', async () => {
    const { read, deltas } = await openLive()
    log(str('x'))
    await waitFor(() => read().entries.length === 1, 'entry')
    await rig.host.console.command({ t: 'console', id: 'n1', op: 'clear' })
    expect(read()).toEqual({ entries: [], dropped: 0 })
    expect(rig.fake.calls.find((c) => c.method === CDP.releaseObjectGroup)?.params).toEqual({ objectGroup: 'console' })
    await waitFor(() => deltas.at(-1)?.reset === true && deltas.at(-1)?.entries.length === 0, 'reset streamed')
  })
})

describe('console eval', () => {
  it('evaluates like the Chrome prompt and records the command and its result', async () => {
    const { read } = await openLive()
    rig.fake.handle(CDP.evaluate, () => ({ result: { type: 'object', className: 'Object', preview: { type: 'object', description: 'Object', properties: [{ name: 'a', type: 'number', value: '1' }] } } }))
    await rig.host.console.command({ t: 'console', id: 'n1', op: 'eval', expr: '({a: 1})' })
    const call = rig.fake.calls.find((c) => c.method === CDP.evaluate)
    expect(call).toMatchObject({ sessionId: SID, params: { expression: '({a: 1})', returnByValue: false, generatePreview: true, userGesture: true, replMode: true } })
    expect(read().entries.map((e) => [e.source, e.text])).toEqual([['command', '({a: 1})'], ['result', '{a: 1}']])
  })

  it('shows a thrown error as an error result', async () => {
    const { read } = await openLive()
    rig.fake.handle(CDP.evaluate, () => ({ result: {}, exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'ReferenceError: nope is not defined' } } }))
    await rig.host.console.command({ t: 'console', id: 'n1', op: 'eval', expr: 'nope' })
    expect(read().entries.at(-1)).toMatchObject({ level: 'error', source: 'result', text: 'Uncaught ReferenceError: nope is not defined' })
  })

  it('refuses unknown nodes', async () => {
    await openLive()
    await expect(rig.host.console.command({ t: 'console', id: 'ghost', op: 'eval', expr: '1' })).rejects.toMatchObject({ code: 'not_found' })
  })
})
