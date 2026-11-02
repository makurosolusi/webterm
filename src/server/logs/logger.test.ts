import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logBus } from './logBus'
import { createFileSink } from './logFileSink'
import { configureLogging, createLogger, flushLogs, getLogLevel, setLogLevel } from './logger'

// test-only: synthetic credentials, never real ones.
const SECRET_KEY_VALUE = 'sk-SYNTHETICsecret0123456789abcdef'
const SECRET_BEARER = 'Bearer SYNTHETICbearer0123456789abcdef'
const SECRET_FIELD_VALUE = 'hunter2-synthetic'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webterm-log-'))
  configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
  setLogLevel('trace')
  logBus.clear()
})
afterEach(() => {
  configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
  rmSync(dir, { recursive: true, force: true })
})

describe('logger', () => {
  it('records level, channel, event, message, ids and data; child and withIds compose', () => {
    const log = createLogger('channels').child('telegram').withIds({ nodeId: 'n1' })
    log.info('telegram.poll.start', 'Polling', { ids: { workspaceId: 'w1' }, count: 3 })
    const [e] = logBus.query()
    expect(e).toMatchObject({ level: 'info', source: 'server', channel: 'channels.telegram', event: 'telegram.poll.start', message: 'Polling' })
    expect(e.ids).toEqual({ nodeId: 'n1', workspaceId: 'w1' })
    expect(e.data).toEqual({ count: 3 })
  })

  it('runtime level gates entries before any work', () => {
    const log = createLogger('x')
    setLogLevel('warn')
    log.info('a.b', 'dropped')
    log.warn('a.c', 'kept')
    expect(logBus.query().map((e) => e.event)).toEqual(['a.c'])
    expect(getLogLevel()).toBe('warn')
  })

  it('redacts secrets in message and data and masks secret-named fields', () => {
    createLogger('auth').error('auth.reject', `failed with ${SECRET_KEY_VALUE} and ${SECRET_BEARER}`, {
      note: `header ${SECRET_BEARER}`,
      botToken: SECRET_FIELD_VALUE,
      nested: { password: SECRET_FIELD_VALUE, ok: 'fine' },
      err: new Error(`bad ${SECRET_KEY_VALUE}`),
    })
    const dump = JSON.stringify(logBus.snapshot())
    for (const secret of [SECRET_KEY_VALUE, 'SYNTHETICbearer', SECRET_FIELD_VALUE]) expect(dump).not.toContain(secret)
    expect(logBus.query()[0].data).toMatchObject({ botToken: '[redacted]', nested: { password: '[redacted]', ok: 'fine' } })
  })

  it('never throws on circular data, throwing getters, bigint and huge payloads', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const hostile = { get boom(): never { throw new Error('getter') } }
    const log = createLogger('x')
    expect(() => {
      log.info('t.circular', 'c', { circular })
      log.info('t.getter', 'g', { hostile })
      log.info('t.bigint', 'b', { n: 10n, fn: () => 1 })
      log.info('t.huge', 'h', { text: 'x'.repeat(100_000), list: Array.from({ length: 10_000 }, (_, i) => i) })
    }).not.toThrow()
    const events = logBus.query().map((e) => e.event)
    expect(events).toEqual(['t.circular', 't.getter', 't.bigint', 't.huge'])
    expect(logBus.query()[0].data).toMatchObject({ circular: { a: 1, self: '[circular]' } })
    expect(JSON.stringify(logBus.query()[3]).length).toBeLessThan(8000)
  })

  it('mirrors to console in VS Code-ish format when enabled', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: true })
    createLogger('pty').warn('pty.error', 'Spawn failed')
    configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \[warn\] \[pty\] Spawn failed$/)
    spy.mockRestore()
  })
})

describe('file sink', () => {
  it('writes JSON lines to the daily file, redacted, via configureLogging (env-controlled)', async () => {
    configureLogging({ env: { WEBTERM_LOG_FILE: 'on' }, dir, console: false })
    createLogger('api').info('http.error', `leak ${SECRET_KEY_VALUE}`, { token: SECRET_FIELD_VALUE })
    await flushLogs()
    const [name] = readdirSync(dir)
    expect(name).toMatch(/^webterm-\d{4}-\d{2}-\d{2}\.log$/)
    const text = readFileSync(join(dir, name), 'utf8')
    expect(text).not.toContain(SECRET_KEY_VALUE)
    expect(text).not.toContain(SECRET_FIELD_VALUE)
    expect(JSON.parse(text.trim().split('\n')[0])).toMatchObject({ channel: 'api', event: 'http.error' })
  })

  it('WEBTERM_LOG_FILE=off writes nothing', async () => {
    configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, dir, console: false })
    createLogger('api').info('a.b', 'x')
    await flushLogs()
    expect(readdirSync(dir)).toEqual([])
  })

  it('rotates by size and by day, pruning to maxFiles', async () => {
    let t = new Date(2026, 10, 1, 12).getTime()
    const sink = createFileSink({ dir, maxFiles: 3, maxFileBytes: 300, now: () => new Date(t) })
    const entry = (seq: number) => ({ seq, ts: t, level: 'info' as const, source: 'server' as const, channel: 'c', event: 'e.v', message: 'x'.repeat(100) })
    for (let i = 1; i <= 4; i++) { t += 1; sink.write(entry(i)); await sink.flush() }
    expect(readdirSync(dir).length).toBeGreaterThan(1) // size rollover produced a renamed file
    for (let day = 0; day < 4; day++) {
      t = new Date(2026, 10, 2 + day, 12).getTime()
      sink.write(entry(10 + day))
      await sink.flush()
    }
    const files = readdirSync(dir).sort()
    expect(files.length).toBeLessThanOrEqual(3)
    expect(files[files.length - 1]).toBe('webterm-2026-11-05.log')
  })

  it('a failing directory does not throw into the caller', async () => {
    const sink = createFileSink({ dir: join(dir, 'a', '\0bad') })
    expect(() => sink.write({ seq: 1, ts: 1, level: 'info', source: 'server', channel: 'c', event: 'e.v', message: 'm' })).not.toThrow()
    await expect(sink.flush()).resolves.toBeUndefined()
  })
})
