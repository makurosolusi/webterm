// Alat test gateway /ws/browser: host palsu (mencatat panggilan) + server `ws` nyata + klien yang mengumpulkan pesan.
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { BrowserInputEvent, BrowserState, Frame, Lease, LeaseView } from '../../shared/browser.contract'
import { createViewerHub } from './browserWs.viewers'
import type { GatewayHost, ViewerHub } from './browserWs.viewers'
import { handleBrowserConnection } from './browserWs.gateway'
import type { HostEvent } from './browserHost.targets'

export const stateOf = (id: string, over: Partial<BrowserState> = {}): BrowserState =>
  ({ id, url: 'https://a.test/', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...over })

/** Host palsu: mencatat semua panggilan; `fail` memaksa metode tertentu melempar. */
export class FakeHost implements GatewayHost {
  starts: string[] = []
  stops: string[] = []
  acks: Array<[string, number]> = []
  inputs: BrowserInputEvent[] = []
  viewports: Array<[string, number, number, number]> = []
  opens: string[] = []
  navs: string[] = []
  stateCbs = new Set<(s: BrowserState) => void>()
  eventCbs = new Set<(e: HostEvent) => void>()
  frames = new Map<string, (f: Frame) => void>()
  fail: Record<string, Error> = {}
  private readonly states = new Map<string, BrowserState>()

  private maybeFail(m: string) { if (this.fail[m]) throw this.fail[m] }
  async open(id: string): Promise<BrowserState> { this.opens.push(id); this.maybeFail('open'); const s = stateOf(id); this.states.set(id, s); return s }
  async navigate(): Promise<void> { throw new Error('unused') }
  async setViewport(id: string, w: number, h: number, dpr: number) { this.viewports.push([id, w, h, dpr]) }
  async startScreencast(id: string, cb: (f: Frame) => void) { this.maybeFail('start'); this.starts.push(id); this.frames.set(id, cb) }
  async stopScreencast(id: string) { this.stops.push(id); this.frames.delete(id) }
  ackFrame(id: string, seq: number) { this.acks.push([id, seq]) }
  async input(_id: string, ev: BrowserInputEvent) { this.maybeFail('input'); this.inputs.push(ev) }
  async cdp(): Promise<unknown> { throw new Error('unused') }
  async discard() { /* tidak dipakai gateway */ }
  state(id: string) { return this.states.get(id) }
  onState(cb: (s: BrowserState) => void) { this.stateCbs.add(cb); return () => { this.stateCbs.delete(cb) } }
  isLoading() { return false }
  onEvent(cb: (e: HostEvent) => void) { this.eventCbs.add(cb); return () => { this.eventCbs.delete(cb) } }
  async answerDialog() { /* tidak dipakai di test */ }
  async navAction(id: string, action: string, url?: string) { this.maybeFail('nav'); this.navs.push(`${id}:${action}:${url ?? ''}`) }
  async selectionText() { return 'selected' }
  /** Dorong state baru ke langganan (seperti host nyata). */
  setState(s: BrowserState) { this.states.set(s.id, s); for (const cb of [...this.stateCbs]) cb({ ...s }) }
  emitFrame(id: string, seq: number) { this.frames.get(id)?.({ seq, jpeg: new Uint8Array([0xff, 0xd8, seq]) }) }
}

export class FakeLeases implements LeaseView {
  holders = new Map<string, Lease>()
  noted: string[] = []
  holder(id: string): Lease { return this.holders.get(id) ?? 'human' }
  noteHumanInput(id: string) { this.noted.push(id) }
  takeover(id: string) { this.holders.set(id, 'human') }
}

export interface Rig {
  host: FakeHost; leases: FakeLeases; hub: ViewerHub; flag: { on: boolean }
  connect(): Promise<Client>
  stop(): Promise<void>
}

export interface Client {
  ws: WebSocket
  json: Array<Record<string, unknown>>
  bin: Uint8Array[]
  send(m: unknown): void
  closed: Promise<number>
}

export async function makeRig(): Promise<Rig> {
  const host = new FakeHost()
  const leases = new FakeLeases()
  const hub = createViewerHub(host, leases)
  const flag = { on: true }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  wss.on('connection', (ws) => handleBrowserConnection(ws, { host, leases, hub, enabled: () => flag.on, workspaceId: 'w1' }))
  const clients: WebSocket[] = []
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return {
    host, leases, hub, flag,
    async connect() {
      const ws = new WebSocket(url)
      clients.push(ws)
      const c: Client = {
        ws, json: [], bin: [], send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
        closed: new Promise((r) => ws.once('close', (code) => r(code))),
      }
      ws.on('message', (d, isBin) => { if (isBin) c.bin.push(new Uint8Array(d as Buffer)); else c.json.push(JSON.parse(String(d))) })
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
      return c
    },
    async stop() {
      for (const w of clients) w.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}
