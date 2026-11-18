// Server CDP tiruan (WS loopback port acak) + penjaga navigasi stub untuk test. Chromium nyata TIDAK dipakai.
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { BlockReason } from '../../shared/browser.contract'
import { BrowserHost } from './browserHost.service'
import type { HostDeps } from './browserHost.service'
import type { NavGuard } from './browserHost.targets'
import type { Adblock } from './adblock.engine'

export interface FakeCall { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
type Reply = Record<string, unknown> | { __error: { code: number; message: string } } | typeof SILENT
export const SILENT = Symbol('silent') // handler mengembalikan ini = tidak menjawab (uji timeout)
export type FakeHandler = (params: Record<string, unknown>, sessionId: string | undefined, call: FakeCall) => Reply | Promise<Reply>

export interface FakeCdp {
  url: string
  calls: FakeCall[]
  /** Ganti jawaban satu method. */
  handle(method: string, h: FakeHandler): void
  /** Dorong event ke klien. */
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void
  /** Putus socket dari sisi server. */
  drop(): void
  methods(): string[]
  close(): Promise<void>
}

/** Mulai server CDP tiruan dengan jawaban bawaan untuk target/riwayat; sisanya `{}`. */
export async function startFakeCdp(): Promise<FakeCdp> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const calls: FakeCall[] = []
  const sockets = new Set<WebSocket>()
  let targets = 0
  const handlers = new Map<string, FakeHandler>([
    ['Target.createTarget', () => ({ targetId: `T${++targets}` })],
    ['Target.attachToTarget', (p) => ({ sessionId: `S-${String(p.targetId)}` })],
    ['Page.getNavigationHistory', () => ({ currentIndex: 0, entries: [{ id: 1, title: 'Title' }] })],
  ])
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
      const call: FakeCall = { id: msg.id, method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId }
      calls.push(call)
      const out = await (handlers.get(msg.method) ?? (() => ({})))(call.params, call.sessionId, call)
      if (out === SILENT) return
      if ('__error' in out) ws.send(JSON.stringify({ id: msg.id, error: out.__error }))
      else ws.send(JSON.stringify({ id: msg.id, result: out, sessionId: msg.sessionId }))
    })
  })
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/fake`,
    calls,
    handle: (m, h) => { handlers.set(m, h) },
    emit: (method, params, sessionId) => { for (const s of sockets) s.send(JSON.stringify({ method, params, sessionId })) },
    drop: () => { for (const s of sockets) s.terminate() },
    methods: () => calls.map((c) => c.method),
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.terminate(); wss.close(() => resolve()) }),
  }
}

/** Penjaga stub: menolak host yang ada di daftar (sebagai `private_host`); selain itu lolos. Hanya untuk test. */
export function stubGuard(blockedHosts: string[] = []): NavGuard & { navigated: string[] } {
  const navigated: string[] = []
  const verdict = (url: string): BlockReason | null => (blockedHosts.includes(new URL(url).hostname) ? 'private_host' : null)
  return { navigated, check: verdict, onFrameNavigated: (u) => { navigated.push(u); return verdict(u) } }
}

/** Tunggu sampai `cond()` benar (event WS tiba async); gagal dengan `what` bila lewat batas. */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Host + server CDP tiruan + peluncur palsu (`acquire` selalu mengembalikan URL tiruan). */
export async function makeHostRig(guard: NavGuard & { navigated: string[] } = stubGuard(), extra: Partial<HostDeps> = {}) {
  const fake = await startFakeCdp()
  const launcher = { acquire: async () => fake.url, shutdown: () => undefined }
  const host = new BrowserHost({ launcher, guard, ...extra })
  return { fake, host, guard, async stop() { await host.dispose(); await fake.close() } }
}

/** Chromium's screencast rules per session: start twice = -32000 "already active"; stop while idle = "not active". Returns the sessions streaming now. */
export function strictScreencast(fake: FakeCdp): Set<string> {
  const active = new Set<string>()
  const err = (message: string) => ({ __error: { code: -32000, message } })
  fake.handle('Page.startScreencast', (_p, sid) => { if (active.has(sid ?? '')) return err('Screencast is already active'); active.add(sid ?? ''); return {} })
  fake.handle('Page.stopScreencast', (_p, sid) => { if (!active.delete(sid ?? '')) return err('Screencast is not active'); return {} })
  return active
}

/** Mesin filter tanpa jaringan untuk test runtime: tak pernah memblokir, `load` tak mengunduh. Hanya untuk test. */
export const offlineAdblock = (): Adblock => ({ check: () => ({ block: false }), load: async () => undefined, ready: () => false })
