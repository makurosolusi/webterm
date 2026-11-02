// Test-only fakes for the log stream: an in-memory /api/logs server and a controllable EventSource.
import { vi } from 'vitest'
import type { LogEntry, LogLevel } from '../../shared/logEntry'

export const makeEntry = (seq: number, patch: Partial<LogEntry> = {}): LogEntry => ({
  seq, ts: new Date(2026, 10, 2, 21, 26, 23, 123).getTime() + seq, level: 'info', source: 'server',
  channel: 'pty', event: 'pty.spawn', message: `message ${seq}`, ...patch,
})

export class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private handlers = new Map<string, (event: MessageEvent) => void>()
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  addEventListener(type: string, handler: (event: MessageEvent) => void): void { this.handlers.set(type, handler) }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  fail(): void { this.onerror?.() }
  send(entry: LogEntry): void { this.sendRaw(JSON.stringify(entry)) }
  sendRaw(data: string): void { this.handlers.get('log')?.({ data } as MessageEvent) }
  static last(): FakeEventSource { return FakeEventSource.instances[FakeEventSource.instances.length - 1]! }
}

export interface FakeServer {
  entries: LogEntry[]
  level: LogLevel
  calls: Array<{ method: string; url: string; body?: unknown }>
  failNext: boolean
}

/** Install fake `fetch` + `EventSource`; the returned server object is mutable between steps. */
export function installFakeLogServer(entries: LogEntry[] = [], level: LogLevel = 'info'): FakeServer {
  const server: FakeServer = { entries, level, calls: [], failNext: false }
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    server.calls.push({ method, url: input, ...(body === undefined ? {} : { body }) })
    const reply = (status: number, json: unknown) => ({
      ok: status < 400, status, headers: { get: () => null }, json: async () => json,
    })
    if (server.failNext) { server.failNext = false; return reply(500, {}) }
    if (method === 'DELETE') { server.entries = []; return reply(200, { ok: true }) }
    if (method === 'PUT') { server.level = (body as { level: LogLevel }).level; return reply(200, { level: server.level }) }
    const afterSeq = Number(new URL(input, 'http://localhost').searchParams.get('afterSeq') ?? 0)
    const lastSeq = server.entries.length === 0 ? 0 : server.entries[server.entries.length - 1]!.seq
    return reply(200, {
      entries: server.entries.filter((entry) => entry.seq > afterSeq).slice(0, 2000),
      lastSeq, channels: [], level: server.level, capacity: 5000, dropped: 0,
    })
  }))
  return server
}
