import { describe, expect, it } from 'vitest'
import type { LogEntry, LogLevel } from '../../shared/logEntry'
import { AGENT_LOG_MAX_BYTES, AGENT_LOG_MAX_ROWS, agentLogQuery, type AgentLogScope } from './logAgentQuery'
import { summarizeLogs } from './logSummary'

const NOW = 1_800_000_000_000
let seq = 0
const entry = (o: Partial<LogEntry> & { level?: LogLevel }): LogEntry => ({
  seq: ++seq, ts: NOW - 1000, level: 'info', source: 'server', channel: 'pty', event: 'pty.spawn', message: 'm', ...o,
})
const agent: AgentLogScope = { self: 'me', peers: new Set(['browser1']), all: false }

describe('agentLogQuery scope', () => {
  const rows = [
    entry({ channel: 'pty', level: 'info', ids: { nodeId: 'me' }, message: 'own info' }),
    entry({ channel: 'browser.page', level: 'info', ids: { nodeId: 'browser1' }, message: 'wired info' }),
    entry({ channel: 'pty', level: 'info', ids: { nodeId: 'other' }, message: 'foreign info' }),
    entry({ channel: 'pty', level: 'warn', ids: { nodeId: 'other' }, message: 'foreign warn' }),
    entry({ channel: 'auth', level: 'error', event: 'auth.reject', message: 'auth error' }),
    entry({ channel: 'credential-proxy', level: 'warn', event: 'credential_proxy.request', message: 'cred warn' }),
    entry({ channel: 'browser.cookies', level: 'error', event: 'browser.cookies_fail', message: 'cookie error' }),
  ]
  const msgs = (r: ReturnType<typeof agentLogQuery>) => r.entries.map((e) => e.message)

  it('own and wired nodes at every level, others only warn+, sensitive channels never', () => {
    expect(msgs(agentLogQuery(rows, { level: 'trace' }, agent, NOW)).sort()).toEqual(['foreign warn', 'own info', 'wired info'])
  })

  it('defaults to warn without a node, info with one', () => {
    expect(msgs(agentLogQuery(rows, {}, agent, NOW))).toEqual(['foreign warn'])
    expect(msgs(agentLogQuery(rows, { node: 'me' }, agent, NOW))).toEqual(['own info'])
  })

  it('a foreign node at info stays hidden even when asked for by id', () => {
    expect(agentLogQuery(rows, { node: 'other', level: 'info' }, agent, NOW).entries.map((e) => e.message)).toEqual(['foreign warn'])
  })

  it('filters by channel prefix, event prefix, text and since', () => {
    const more = [entry({ channel: 'browser.ssrf', level: 'warn', event: 'browser.ssrf.block', message: 'blocked x', ts: NOW - 30 * 60_000 }), ...rows]
    expect(agentLogQuery(more, { channel: 'browser', level: 'warn' }, agent, NOW).entries).toHaveLength(1)
    expect(agentLogQuery(more, { event: 'browser.ssrf', level: 'warn' }, agent, NOW).entries).toHaveLength(1)
    expect(agentLogQuery(more, { event: 'browser.ssrf', level: 'warn', since: '10m' }, agent, NOW).entries).toHaveLength(0)
    expect(agentLogQuery(more, { q: 'BLOCKED', level: 'warn' }, agent, NOW).entries).toHaveLength(1)
  })
})

describe('agentLogQuery limits and redaction', () => {
  it('caps rows at 200 and keeps the newest', () => {
    const many = Array.from({ length: 500 }, (_, i) => entry({ level: 'warn', message: `row ${i}` }))
    const r = agentLogQuery(many, { limit: 5000 }, agent, NOW)
    expect(r.entries).toHaveLength(AGENT_LOG_MAX_ROWS)
    expect(r.truncated).toBe(true)
    expect(r.entries.at(-1)?.message).toBe('row 499')
  })

  it('caps the response at 64 KB', () => {
    const fat = Array.from({ length: 150 }, (_, i) => entry({ level: 'warn', message: 'x'.repeat(400), data: { blob: 'y'.repeat(400), i } }))
    const r = agentLogQuery(fat, { limit: 200 }, agent, NOW)
    expect(JSON.stringify(r.entries).length).toBeLessThanOrEqual(AGENT_LOG_MAX_BYTES)
    expect(r.truncated).toBe(true)
  })

  it('removes URL query strings, tokens and headers from message and data', () => {
    const r = agentLogQuery([entry({
      level: 'warn', message: 'failed https://a.test/v?sig=SECRETSIG&t=1#frag with Bearer abcdefghijklmnop',
      data: { url: 'https://b.test/p?token=zzz', headers: { cookie: 'c=1' }, note: 'api_key=sk-abcdefghijklmnopqrstuv' },
    })], {}, agent, NOW)
    const text = JSON.stringify(r.entries)
    for (const leak of ['SECRETSIG', 'frag', 'abcdefghijklmnop', 'token=zzz', 'c=1', 'sk-abcdef']) expect(text).not.toContain(leak)
    expect(text).toContain('https://a.test/v')
    expect(text).toContain('https://b.test/p')
  })
})

describe('summarizeLogs', () => {
  const page = (o: { category: string; host: string; status?: number; path?: string; count: number; kind?: string; node?: string }) => entry({
    channel: 'browser.page', level: 'error', event: 'browser.page_net_error', ids: { nodeId: o.node ?? 'browser1' },
    data: { kind: o.kind ?? 'net', category: o.category, host: o.host, path: o.path ?? '', ...(o.status ? { status: o.status } : {}), count: o.count, firstTs: NOW - 5000, lastTs: NOW - 1000 },
  })
  const rows = [
    page({ category: 'http_403', host: 'rr1.googlevideo.com', status: 403, path: '/videoplayback', count: 1 }),
    page({ category: 'http_403', host: 'rr1.googlevideo.com', status: 403, path: '/videoplayback', count: 25 }),
    page({ category: 'ERR_BLOCKED_BY_CLIENT', host: 'ads.test', count: 3 }),
    page({ category: 'ERR_TUNNEL_CONNECTION_FAILED', host: 'rr2.googlevideo.com', count: 6 }),
    entry({ channel: 'browser.ssrf', level: 'warn', event: 'browser.ssrf.block', data: { hostname: 'googlevideo.com', reason: 'private_address' } }),
    entry({ channel: 'pty', level: 'info', message: 'noise' }),
  ]

  it('groups failures by category, host and status with hints and the max running count', () => {
    const s = summarizeLogs(rows, {}, agent, NOW)
    const yt = s.pageFailures.find((g) => g.status === 403)
    expect(yt).toMatchObject({ count: 25, host: 'rr1.googlevideo.com' })
    expect(yt?.hint).toMatch(/YouTube refused a media segment/)
    expect(s.pageFailures.find((g) => g.category === 'ERR_BLOCKED_BY_CLIENT')?.hint).toMatch(/built-in webterm blocker/)
    expect(s.pageFailures).toHaveLength(3)
    expect(s.byLevel).toMatchObject({ error: 4, warn: 1 })
    expect(s.diagnosis.length).toBeGreaterThanOrEqual(3)
  })

  it('links the tunnel failure to the ssrf server event for the same host', () => {
    const s = summarizeLogs(rows, {}, agent, NOW)
    const tunnel = s.pageFailures.find((g) => g.category === 'ERR_TUNNEL_CONNECTION_FAILED')
    expect(tunnel?.serverEvents?.[0]).toContain('browser.ssrf.block (private_address)')
    expect(s.serverEvents[0]).toMatchObject({ event: 'browser.ssrf.block', hostname: 'googlevideo.com' })
  })

  it('narrows to one node and honours the window', () => {
    const s = summarizeLogs([...rows, page({ category: 'ERR_ABORTED', host: 'x.test', count: 2, node: 'zzz' })], { node: 'browser1', since: '1m' }, agent, NOW)
    expect(s.pageFailures.some((g) => g.host === 'x.test')).toBe(false)
    expect(summarizeLogs(rows, { since: '1s' }, agent, NOW + 5000).pageFailures).toHaveLength(0)
  })
})
