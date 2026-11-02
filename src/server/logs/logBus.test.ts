import { describe, expect, it } from 'vitest'
import type { LogLevel } from '../../shared/logEntry'
import { createLogBus, DEFAULT_LOG_BUFFER, parseCapacity, type NewLogEntry } from './logBus'

const mk = (over: Partial<NewLogEntry> = {}): NewLogEntry => ({
  ts: 1, level: 'info', source: 'server', channel: 'pty', event: 'pty.spawn', message: 'Spawned shell', ...over,
})

describe('logBus ring buffer', () => {
  it('assigns monotonic seq and keeps lastSeq', () => {
    const bus = createLogBus(100)
    expect(bus.append(mk()).seq).toBe(1)
    expect(bus.append(mk()).seq).toBe(2)
    expect(bus.lastSeq).toBe(2)
  })

  it('evicts the oldest past capacity and counts dropped', () => {
    const bus = createLogBus(3)
    for (let i = 0; i < 5; i++) bus.append(mk({ message: `m${i}` }))
    expect(bus.query().map((e) => e.message)).toEqual(['m2', 'm3', 'm4'])
    expect(bus.dropped).toBe(2)
    expect(bus.lastSeq).toBe(5)
  })

  it('clear empties the buffer but keeps seq and does not count as dropped', () => {
    const bus = createLogBus(10)
    bus.append(mk())
    bus.clear()
    expect(bus.query()).toEqual([])
    expect(bus.dropped).toBe(0)
    expect(bus.append(mk()).seq).toBe(2)
  })

  it('shrinking capacity evicts and counts', () => {
    const bus = createLogBus(10)
    for (let i = 0; i < 6; i++) bus.append(mk())
    bus.setCapacity(4)
    expect(bus.query()).toHaveLength(4)
    expect(bus.dropped).toBe(2)
  })

  it('parseCapacity falls back on junk and out-of-range values', () => {
    expect(parseCapacity(undefined)).toBe(DEFAULT_LOG_BUFFER)
    for (const bad of ['abc', '5', '1.5', '99999999', '-10']) expect(parseCapacity(bad), bad).toBe(DEFAULT_LOG_BUFFER)
    expect(parseCapacity(' 250 ')).toBe(250)
  })
})

describe('logBus query', () => {
  const bus = createLogBus(100)
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
  levels.forEach((level, i) => bus.append(mk({ level, channel: i < 2 ? 'pty' : 'channels.telegram', message: `Msg ${level}` })))

  it('filters by minimum level', () => {
    expect(bus.query({ level: 'warn' }).map((e) => e.level)).toEqual(['warn', 'error'])
  })
  it('filters by channel, including child channels of a parent', () => {
    expect(bus.query({ channel: 'pty' })).toHaveLength(2)
    expect(bus.query({ channel: 'channels' })).toHaveLength(2)
    expect(bus.query({ channel: 'chan' })).toHaveLength(0)
  })
  it('substring filter is case-insensitive over channel, event and message', () => {
    expect(bus.query({ q: 'MSG WARN' })).toHaveLength(1)
    expect(bus.query({ q: 'telegram' })).toHaveLength(2)
    expect(bus.query({ q: 'nope' })).toHaveLength(0)
  })
  it('afterSeq resumes with the oldest entries after it; no cursor returns the newest', () => {
    expect(bus.query({ afterSeq: 2 }).map((e) => e.seq)).toEqual([3, 4])
    expect(bus.query({ afterSeq: 1, limit: 2 }).map((e) => e.seq)).toEqual([2, 3])
    expect(bus.query({ limit: 2 }).map((e) => e.seq)).toEqual([3, 4])
  })
  it('channel counts', () => {
    expect(bus.channels()).toEqual([{ channel: 'channels.telegram', count: 2 }, { channel: 'pty', count: 2 }])
  })
})

describe('logBus subscribers', () => {
  it('delivers entries, unsubscribes, and drops a listener that throws without affecting others', () => {
    const bus = createLogBus(10)
    const got: number[] = []
    const off = bus.subscribe((e) => got.push(e.seq))
    bus.subscribe(() => { throw new Error('boom') })
    expect(bus.subscriberCount).toBe(2)
    bus.append(mk())
    expect(got).toEqual([1])
    expect(bus.subscriberCount).toBe(1)
    off()
    bus.append(mk())
    expect(got).toEqual([1])
    expect(bus.subscriberCount).toBe(0)
  })
})
