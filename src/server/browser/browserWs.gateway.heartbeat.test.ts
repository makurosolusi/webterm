// Lock for the /ws/browser heartbeat: same ping/pong rule as /ws (terminalSocket.test.ts).
// Fake socket + fake timers; no network, no host work (nothing is attached).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WS_HEARTBEAT_MS } from '../terminalSocket'
import { handleBrowserConnection, type GatewayDeps } from './browserWs.gateway'

type Handler = (...args: unknown[]) => void

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  pings = 0
  terminated = 0
  private handlers = new Map<string, Handler>()
  send(): void {}
  close(): void {}
  ping(): void { this.pings++ }
  terminate(): void { this.terminated++ }
  on(event: string, cb: Handler): this { this.handlers.set(event, cb); return this }
  fire(event: string, ...args: unknown[]): void { this.handlers.get(event)?.(...args) }
}

function serve(): FakeSocket {
  const ws = new FakeSocket()
  const deps = { host: {}, leases: {}, hub: {}, enabled: () => true, workspaceId: 'w1' } as unknown as GatewayDeps // test-only
  handleBrowserConnection(ws as never, deps)
  return ws
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('browser gateway heartbeat', () => {
  test('a socket that answers pings stays; one that misses a pong is terminated', () => {
    const ws = serve()
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.pings).toBe(1)
    ws.fire('pong')
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(2)
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
  })

  test('close stops the heartbeat', () => {
    const ws = serve()
    ws.fire('close')
    vi.advanceTimersByTime(WS_HEARTBEAT_MS * 3)
    expect(ws.pings).toBe(0)
    expect(ws.terminated).toBe(0)
  })
})
