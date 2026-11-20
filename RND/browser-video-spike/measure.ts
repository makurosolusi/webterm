// SPIKE: jangan merge ke produk. One measured run: product launch flags + product CdpClient + product viewer hub (flow control).
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromium } from '../../src/server/browser/chromium.launch'
import { DEFAULT_VIEWPORT, windowPlacement } from '../../src/server/browser/chromium.flags'
import { CDP, CDP_EVENT, CdpClient } from '../../src/server/browser/cdp.client'
import { screencastParams } from '../../src/server/browser/browserHost.input'
import { createViewerHub } from '../../src/server/browser/browserWs.viewers'
import type { Viewer } from '../../src/server/browser/browserWs.viewers'
import { childEnv } from '../../src/server/childEnv'
import type { Scenario } from './pages'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type Flow = 'server' | 'hub' | 'wait'
/** `server`: Chromium acked on receipt, no client. `hub`: the PRODUCT hub (ack on receipt + 2-in-flight gate to the client) behind a simulated RTT. `wait`: naive, Chromium acked only after the client acked. */
export interface Cfg { name: string; quality: number; dpr: number; nth: number; flow: Flow; rtt: number }
export interface Launch { name: string; headless: boolean; extra: string[] }

// ---------- browser ----------
export interface Browser { cdp: CdpClient; pid: number; kill(): void; dirs: string[] }
export async function launchBrowser(bin: string, proxyPort: number, l: Launch): Promise<Browser> {
  const dirs = [mkdtempSync(join(tmpdir(), 'wt-vid-prof-')), mkdtempSync(join(tmpdir(), 'wt-vid-home-'))]
  let pid = 0
  const launched = await launchChromium({ bin, profileDir: dirs[0], proxyServer: `http://127.0.0.1:${proxyPort}`, headless: l.headless }, {
    spawn: (b, args) => {
      const c = spawn(b, [...args, ...l.extra, '--mute-audio', '--use-mock-keychain', '--password-store=basic', '--autoplay-policy=no-user-gesture-required'], { env: childEnv({ HOME: dirs[1] }), stdio: ['ignore', 'ignore', 'pipe'] })
      pid = c.pid!
      return c
    },
  })
  const cdp = await CdpClient.connect(launched.wsUrl)
  return { cdp, pid, dirs, kill() { try { cdp.close() } catch { /* closed */ } launched.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) } }
}

// ---------- cpu of a process tree (seconds): /proc on Linux (no `ps` needed in slim images), `ps` elsewhere ----------
const CLK = 100 // USER_HZ on Linux
function rows(): Array<{ pid: number; ppid: number; cpu: number }> {
  if (process.platform === 'linux') {
    const out: Array<{ pid: number; ppid: number; cpu: number }> = []
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const s = readFileSync(`/proc/${d}/stat`, 'utf8')
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ') // fields from #3: state ppid ... utime(14) stime(15)
        out.push({ pid: +d, ppid: +f[1], cpu: (+f[11] + +f[12]) / CLK })
      } catch { /* exited */ }
    }
    return out
  }
  const t = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,cputime='], { stdout: 'pipe' }).stdout.toString()
  return t.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, c]) => ({ pid: +pid, ppid: +ppid, cpu: c.split(':').reduce((s, x) => s * 60 + Number(x), 0) }))
}
export function treeCpu(root: number): Map<number, number> {
  const all = rows()
  const mine = new Set([root])
  for (let grew = true; grew;) { grew = false; for (const r of all) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true } }
  return new Map(all.filter((r) => mine.has(r.pid)).map((r) => [r.pid, r.cpu]))
}
const cpuDelta = (a: Map<number, number>, b: Map<number, number>) => [...b].reduce((s, [pid, c]) => s + c - (a.get(pid) ?? 0), 0)

// ---------- stats ----------
export const pct = (a: number[], p: number): number => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] }
export const med = (a: number[]) => pct(a, 0.5)
const r1 = (x: number) => Math.round(x * 10) / 10
export interface Gaps { n: number; fps: number; med: number; p95: number; p99: number; over100: number; over250: number }
export function gapStats(t: number[], seconds: number): Gaps {
  const g = t.slice(1).map((x, i) => x - t[i])
  return { n: t.length, fps: r1(t.length / seconds), med: r1(med(g)), p95: r1(pct(g, 0.95)), p99: r1(pct(g, 0.99)), over100: g.filter((x) => x > 100).length, over250: g.filter((x) => x > 250).length }
}

export interface RunResult {
  server: Gaps; client: Gaps | null; jpegKB: number; chromiumCpu: number; bunCpu: number
  holdMs: { med: number; p95: number } | null; ackMs: { med: number; p95: number } | null; sent: number | null
  page: { fps?: number; videoFps?: number; videoDroppedPct?: number } | null
  gaps: number[]
}

/** One measurement: fresh tab, warm-up, then `seconds` of screencast under `cfg`. */
export async function runOnce(b: Browser, url: string, scenario: Scenario, cfg: Cfg, seconds: number): Promise<RunResult> {
  const { cdp } = b
  const { targetId } = await cdp.send<{ targetId: string }>(CDP.createTarget, { url: 'about:blank', ...windowPlacement() })
  const { sessionId } = await cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
  const send = <T>(m: string, p?: object) => cdp.send<T>(m, p, sessionId)
  const ev = async <T>(expression: string) => (await send<{ result: { value: T } }>(CDP.evaluate, { expression, returnByValue: true })).result.value
  try {
    await send(CDP.pageEnable, {})
    await send(CDP.setDeviceMetrics, { width: DEFAULT_VIEWPORT.w, height: DEFAULT_VIEWPORT.h, deviceScaleFactor: cfg.dpr, mobile: false })
    await send(CDP.setFocusEmulation, { enabled: true })
    const loaded = new Promise<void>((res) => { const off = cdp.on('Page.loadEventFired', (_p, s) => { if (s === sessionId) { off(); res() } }); setTimeout(res, 8000) })
    await send(CDP.navigate, { url })
    await loaded
    await sleep(scenario === 'video' ? 5000 : 1500) // video: the in-page recording fallback needs ~4 s before it plays

    const params = { ...screencastParams({ w: DEFAULT_VIEWPORT.w, h: DEFAULT_VIEWPORT.h, dpr: cfg.dpr }), quality: cfg.quality, ...(cfg.nth > 1 ? { everyNthFrame: cfg.nth } : {}) }
    const arrive: number[] = [], paint: number[] = [], sizes: number[] = [], hold: number[] = [], ackMs: number[] = []
    const ids = new Map<number, number>() // our seq -> Chromium ack id
    const at = new Map<number, number>() // our seq -> arrival ms
    const sentAt = new Map<number, number>()
    let seq = 0, sent = 0, recording = false
    let hostOnFrame: ((f: { seq: number; jpeg: Uint8Array }) => void) | null = null
    const ackChromium = (s: number) => { const id = ids.get(s); if (id !== undefined) { ids.delete(s); cdp.send(CDP.screencastFrameAck, { sessionId: id }, sessionId).catch(() => undefined) } }

    // simulated client behind the product hub: write completes at once, paint at rtt/2, ack back at rtt
    const viewer: Viewer = {
      sink: {
        bufferedAmount: 0,
        sendJson: () => undefined,
        sendBinary(bytes, done) {
          const s = new DataView(bytes.buffer, bytes.byteOffset).getUint32(2 + bytes[1], false)
          const t0 = performance.now()
          if (recording) { sent++; hold.push(t0 - (at.get(s) ?? t0)) }
          done?.()
          setTimeout(() => { if (recording) paint.push(performance.now()); setTimeout(() => { if (recording) ackMs.push(performance.now() - t0); hub?.ack('n', viewer, s) }, cfg.rtt / 2) }, cfg.rtt / 2)
          return true
        },
      },
    }
    const host = {
      onState: () => () => undefined, onEvent: () => () => undefined,
      state: () => ({ id: 'n', live: 'live' }),
      startScreencast: async (_id: string, onFrame: typeof hostOnFrame) => { hostOnFrame = onFrame; await send(CDP.startScreencast, params) },
      stopScreencast: async () => { await send(CDP.stopScreencast).catch(() => undefined) },
      ackFrame: (_id: string, s: number) => ackChromium(s),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hub = cfg.flow === 'hub' ? createViewerHub(host as any, { holder: () => 'human' } as any) : null

    const off = cdp.on(CDP_EVENT.screencastFrame, (p: Record<string, unknown>, sid?: string) => {
      if (sid !== sessionId || typeof p.data !== 'string') return
      const now = performance.now()
      const jpeg = Buffer.from(p.data, 'base64') // the product decodes base64 per frame too
      const s = ++seq
      ids.set(s, p.sessionId as number)
      if (recording) { arrive.push(now); sizes.push(jpeg.length) }
      if (cfg.flow === 'server') ackChromium(s)
      else if (cfg.flow === 'wait') setTimeout(() => { if (recording) paint.push(performance.now()); setTimeout(() => { if (recording) ackMs.push(performance.now() - now); ackChromium(s) }, cfg.rtt / 2) }, cfg.rtt / 2)
      else { at.set(s, now); sentAt.delete(s); hostOnFrame?.({ seq: s, jpeg }) }
    })

    if (hub) { hub.join('n', viewer); await hub.sync('n') } else await send(CDP.startScreencast, params)
    await sleep(2000) // warm-up of the stream
    const pageBefore = scenario === 'canvas' ? await ev<number>('window.__n') : scenario === 'video' ? await ev<{ total: number; dropped: number }>('window.__vq()') : null
    const c0 = treeCpu(b.pid), u0 = process.cpuUsage(), t0 = performance.now()
    recording = true
    await sleep(seconds * 1000)
    recording = false
    const secs = (performance.now() - t0) / 1000
    const c1 = treeCpu(b.pid), u1 = process.cpuUsage(u0)
    const pageAfter = scenario === 'canvas' ? await ev<number>('window.__n') : scenario === 'video' ? await ev<{ total: number; dropped: number }>('window.__vq()') : null
    off()
    if (hub) await hub.leave('n', viewer); else await send(CDP.stopScreencast).catch(() => undefined)

    const page: RunResult['page'] = scenario === 'canvas' ? { fps: r1(((pageAfter as number) - (pageBefore as number)) / secs) }
      : scenario === 'video' ? (() => { const a = pageAfter as { total: number; dropped: number }, p = pageBefore as { total: number; dropped: number }; const tot = a.total - p.total; return { videoFps: r1(tot / secs), videoDroppedPct: tot > 0 ? r1(100 * (a.dropped - p.dropped) / tot) : 0 } })() : null
    const lat = (a: number[]) => (a.length ? { med: r1(med(a)), p95: r1(pct(a, 0.95)) } : null)
    return {
      server: gapStats(arrive, secs), client: cfg.flow === 'server' ? null : gapStats(paint, secs),
      jpegKB: r1(med(sizes) / 1024), chromiumCpu: r1(100 * cpuDelta(c0, c1) / secs), bunCpu: r1(100 * (u1.user + u1.system) / 1e6 / secs),
      holdMs: cfg.flow === 'hub' ? lat(hold) : null, ackMs: lat(ackMs), sent: cfg.flow === 'hub' ? sent : null, page,
      gaps: [...arrive.slice(1).map((x, i) => x - arrive[i])], // raw gaps: pooled across reps by the caller
    }
  } finally {
    await cdp.send(CDP.closeTarget, { targetId }).catch(() => undefined)
  }
}
