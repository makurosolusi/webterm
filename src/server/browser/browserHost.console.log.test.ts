import { afterEach, describe, expect, it } from 'vitest'
import { CDP_EVENT } from './cdp.client'
import { makeHostRig, waitFor } from './fakeCdp.testkit'
import { createPageLogBridge, PAGE_LOG_RATE } from './browserHost.console.log'
import { logBus } from '../logs'
import type { Logger } from '../logs'
import type { EntryBody } from './browserHost.console.format'

const SRC = { nodeId: 'n1', workspaceId: 'w1', profileId: 'p1' }
interface Call { level: string; event: string; message: string; fields: Record<string, unknown> & { ids?: Record<string, string> } }
function rig() {
  const calls: Call[] = []
  const at = (level: string) => (event: string, message: string, fields: Call['fields'] = {}) => { calls.push({ level, event, message, fields }) }
  const logger = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') } as unknown as Logger
  const clock = { t: 1_800_000_000_000 }
  return { calls, clock, bridge: createPageLogBridge({ now: () => clock.t, logger }) }
}
const net = (text: string, url: string, level: EntryBody['level'] = 'error'): EntryBody => ({ level, source: 'network', text, url })

describe('page log bridge', () => {
  it('logs a network failure once with host, status and a query-free path', () => {
    const { calls, bridge } = rig()
    bridge.record(SRC, net('Failed to load resource: the server responded with a status of 403 ()', 'https://rr1.googlevideo.com/videoplayback?sig=SECRET&expire=1#x'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ level: 'error', event: 'browser.page_net_error', fields: { category: 'http_403', host: 'rr1.googlevideo.com', status: 403, path: '/videoplayback', count: 1, ids: SRC } })
    expect(JSON.stringify(calls)).not.toMatch(/SECRET|expire|sig=/)
  })

  it('aggregates repeats: re-emits at 5 and 25 with the running count and first/last time', () => {
    const { calls, clock, bridge } = rig()
    const first = clock.t
    for (let i = 1; i <= 30; i++) { clock.t += 10; bridge.record(SRC, net('net::ERR_FAILED', 'https://cdn.test/p.js?x=1')) }
    expect(calls.map((c) => c.fields.count)).toEqual([1, 5, 25])
    expect(calls[2].fields).toMatchObject({ firstTs: first + 10, lastTs: first + 250 })
  })

  it('drops info/verbose, prompt echoes and results; keeps console errors, warnings and exceptions', () => {
    const { calls, bridge } = rig()
    bridge.record(SRC, { level: 'info', source: 'console', text: 'hello' })
    bridge.record(SRC, { level: 'verbose', source: 'network', text: 'net::ERR_ABORTED', url: 'https://a.test/' })
    bridge.record(SRC, { level: 'error', source: 'result', text: 'x' })
    bridge.record(SRC, { level: 'error', source: 'console', text: 'boom at https://a.test/app.js?token=abcdef123456 count 12' })
    bridge.record(SRC, { level: 'warning', source: 'console', text: 'careful' })
    bridge.record(SRC, { level: 'error', source: 'exception', text: 'Uncaught TypeError: x is not a function'.repeat(20) })
    expect(calls.map((c) => c.event)).toEqual(['browser.page_console_error', 'browser.page_console_error', 'browser.page_exception'])
    expect(calls[1].level).toBe('warn')
    expect(calls[0].message).not.toContain('abcdef123456')
    expect(calls[0].message).toContain('https://a.test/app.js')
    expect(calls[2].message.length).toBeLessThanOrEqual(301)
  })

  it('limits distinct entries per node per second and counts what it suppressed', () => {
    const { calls, clock, bridge } = rig()
    for (let i = 0; i < PAGE_LOG_RATE + 10; i++) bridge.record(SRC, net('net::ERR_FAILED', `https://h${i}.test/x`))
    expect(calls).toHaveLength(PAGE_LOG_RATE)
    clock.t += 1000
    bridge.record(SRC, net('net::ERR_FAILED', 'https://late.test/x'))
    expect(calls.at(-1)?.fields).toMatchObject({ host: 'late.test', suppressed: 10 })
    // another node has its own budget
    bridge.record({ ...SRC, nodeId: 'n2' }, net('net::ERR_FAILED', 'https://h0.test/x'))
    expect(calls.at(-1)?.fields.ids?.nodeId).toBe('n2')
  })
})

describe('page log bridge: blocker-caused failures', () => {
  const ads = (_: string, u: string) => u.includes('ads.test') || u.includes('doubleclick.net')
  const rigAds = () => {
    const calls: Call[] = []
    const at = (level: string) => (event: string, message: string, fields: Call['fields'] = {}) => { calls.push({ level, event, message, fields }) }
    const logger = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') } as unknown as Logger
    return { calls, bridge: createPageLogBridge({ now: () => 1_800_000_000_000, logger, isBlocked: ads }) }
  }
  const cors = (at: string, from?: string) => ({ level: 'error', source: 'console', text: `Access to XMLHttpRequest at '${at}'${from ? ` (redirected from '${from}')` : ''} from origin 'https://www.youtube.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header` }) as EntryBody

  it('demotes ERR_BLOCKED_BY_CLIENT to debug even without a filter engine', () => {
    const { calls, bridge } = rig()
    bridge.record(SRC, net('net::ERR_BLOCKED_BY_CLIENT', 'https://www.youtube.com/youtubei/v1/log_event?a=1'))
    expect(calls.map((c) => c.level)).toEqual(['debug'])
  })

  it('demotes ERR_FAILED and CORS errors only for URLs the blocker would block', () => {
    const { calls, bridge } = rigAds()
    bridge.record(SRC, net('net::ERR_FAILED', 'https://ad.doubleclick.net/ddm/trackimp/x'))
    bridge.record(SRC, cors('https://ad.doubleclick.net/ddm/trackimp/x'))
    bridge.record(SRC, cors('https://googleads.g.doubleclick.net/measurement/f', 'https://www.youtube.com/measurement/f'))
    expect(calls.map((c) => c.level)).toEqual(['debug', 'debug', 'debug'])
    bridge.record(SRC, net('net::ERR_FAILED', 'https://api.site.test/data'))
    bridge.record(SRC, cors('https://api.site.test/data'))
    bridge.record(SRC, net('net::ERR_NAME_NOT_RESOLVED', 'https://ads.test/x'))
    bridge.record(SRC, net('Failed to load resource: the server responded with a status of 503 ()', 'https://ads.test/y'))
    expect(calls.slice(3).map((c) => c.level)).toEqual(['error', 'error', 'error', 'error'])
  })

  it('blocked noise does not spend the rate budget of real failures', () => {
    const { calls, bridge } = rigAds()
    for (let i = 0; i < PAGE_LOG_RATE * 2; i++) bridge.record(SRC, net('net::ERR_BLOCKED_BY_CLIENT', `https://h${i}.test/x`))
    bridge.record(SRC, net('net::ERR_NAME_NOT_RESOLVED', 'https://real.test/x'))
    expect(calls.at(-1)).toMatchObject({ level: 'error', fields: { host: 'real.test' } })
    expect(calls.at(-1)?.fields.suppressed).toBeUndefined()
  })
})

describe('console route feeds the server log', () => {
  let host: Awaited<ReturnType<typeof makeHostRig>>
  afterEach(async () => { await host?.stop() })

  it('a Log.entryAdded network failure lands in the log bus as browser.page with the node id', async () => {
    host = await makeHostRig()
    await host.host.open('n1', 'w1', 'https://a.test/')
    host.fake.emit(CDP_EVENT.logEntryAdded, { entry: { source: 'network', level: 'error', text: 'Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED', url: 'https://rr9.googlevideo.com/videoplayback?sig=ZZZ' } }, 'S-T1')
    await waitFor(() => logBus.query({ channel: 'browser.page' }).some((e) => e.ids?.nodeId === 'n1'), 'bridged entry')
    const e = logBus.query({ channel: 'browser.page' }).at(-1)
    expect(e).toMatchObject({ event: 'browser.page_net_error', level: 'error', data: { category: 'ERR_TUNNEL_CONNECTION_FAILED', host: 'rr9.googlevideo.com' } })
    expect(JSON.stringify(e)).not.toContain('ZZZ')
  })
})
