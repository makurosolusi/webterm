// SPIKE: jangan merge ke produk. Harness: launch Chromium pakai peluncur repo, CDP pakai CdpClient repo, server uji lokal.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { windowPlacement, DEFAULT_VIEWPORT } from '../../src/server/browser/chromium.flags'
import { launchChromium } from '../../src/server/browser/chromium.launch'
import { CdpClient, CDP, CDP_EVENT } from '../../src/server/browser/cdp.client'
import { childEnv } from '../../src/server/childEnv'
import { PAGE_HTML, PAGE_JS } from './testpage'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const BIN = process.env.WEBTERM_BROWSER_BIN || `${process.env.HOME}/.webterm-server/browser/chrome-for-testing/158.0.8127.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

export const tmp: string[] = []
export const mkTmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d }
export function cleanupTmp() { for (const d of tmp) rmSync(d, { recursive: true, force: true }) }

// ---------- local servers: two origins (127.0.0.1 and localhost = cross-site) + a forwarding proxy (webterm forces a proxy) ----------
export interface Servers { a: number; b: number; proxy: number; stop(): void }
export function startServers(wav: Uint8Array, webm: Uint8Array): Servers {
  const handler = (req: Request): Response => {
    const u = new URL(req.url)
    const h: Record<string, string> = {}
    if (u.pathname === '/tone.wav') return new Response(wav, { headers: { 'content-type': 'audio/wav', ...(u.searchParams.has('cors') ? { 'access-control-allow-origin': '*' } : {}) } })
    if (u.pathname === '/tone.webm') return new Response(webm, { headers: { 'content-type': 'audio/webm', 'access-control-allow-origin': '*' } })
    if (u.pathname === '/page.js') return new Response(PAGE_JS, { headers: { 'content-type': 'text/javascript' } })
    if (u.pathname === '/page.html') {
      if (u.searchParams.has('csp')) h['content-security-policy'] = "default-src 'none'; script-src 'self'; media-src 'self' blob:; style-src 'unsafe-inline'; img-src data:"
      h['content-type'] = 'text/html'
      return new Response(PAGE_HTML, { headers: h })
    }
    return new Response('nf', { status: 404 })
  }
  const a = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler })
  const b = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler }) // reached as http://localhost:<b> through the proxy
  const proxy = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      u.hostname = '127.0.0.1' // localhost -> loopback
      if (![String(a.port), String(b.port)].includes(u.port)) return new Response('blocked', { status: 403 })
      return fetch(u, { headers: req.headers, method: req.method })
    },
  })
  return { a: a.port!, b: b.port!, proxy: proxy.port!, stop() { a.stop(true); b.stop(true); proxy.stop(true) } }
}

// ---------- browser ----------
export interface Browser { cdp: CdpClient; pid: number; kill(): void }
export interface LaunchOpts { headless: boolean; extra: string[]; proxyPort: number }
/** Launch via the repo's launchChromium + buildChromiumArgs; `extra` flags appended through the spawn seam (SPIKE-only: --mute-audio etc.). */
export async function launchBrowser(o: LaunchOpts): Promise<Browser> {
  const profile = mkTmp('wt-audio-prof-')
  const home = mkTmp('wt-audio-home-')
  let pid = 0
  const l = await launchChromium({ bin: BIN, profileDir: profile, proxyServer: `http://127.0.0.1:${o.proxyPort}`, headless: o.headless }, {
    spawn: (bin, args) => {
      const c = spawn(bin, [...args, ...o.extra, '--use-mock-keychain', '--password-store=basic'], { env: childEnv({ HOME: home }), stdio: ['ignore', 'ignore', 'pipe'] })
      pid = c.pid!
      return c
    },
  })
  const cdp = await CdpClient.connect(l.wsUrl)
  return { cdp, pid, kill() { try { cdp.close() } catch { /* closed */ } l.kill() } }
}

export interface Page { sid: string; targetId: string }
export async function newPage(b: Browser, prep: (sid: string) => Promise<void>): Promise<Page> {
  const { targetId } = await b.cdp.send<{ targetId: string }>(CDP.createTarget, { url: 'about:blank', ...windowPlacement() })
  const { sessionId } = await b.cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
  await b.cdp.send(CDP.pageEnable, {}, sessionId)
  await b.cdp.send(CDP.setDeviceMetrics, { width: DEFAULT_VIEWPORT.w, height: DEFAULT_VIEWPORT.h, deviceScaleFactor: 1, mobile: false }, sessionId)
  await b.cdp.send(CDP.setFocusEmulation, { enabled: true }, sessionId)
  await prep(sessionId)
  return { sid: sessionId, targetId }
}
export async function closePage(b: Browser, p: Page) { await b.cdp.send(CDP.closeTarget, { targetId: p.targetId }).catch(() => undefined) }
export async function evalIn<T = unknown>(b: Browser, sid: string, expression: string, userGesture = false): Promise<T> {
  const r = await b.cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(CDP.evaluate, { expression, awaitPromise: true, returnByValue: true, userGesture }, sid)
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
export async function waitLoad(b: Browser, sid: string, url: string) {
  const done = new Promise<void>((res) => { const off = b.cdp.on('Page.loadEventFired', (_p, s) => { if (s === sid) { off(); res() } }) })
  await b.cdp.send(CDP.navigate, { url }, sid)
  await Promise.race([done, sleep(8000)])
}
export async function click(b: Browser, sid: string) {
  for (const type of ['mousePressed', 'mouseReleased']) await b.cdp.send(CDP.mouse, { type, x: 200, y: 200, button: 'left', clickCount: 1 }, sid)
}
export { CDP, CDP_EVENT }

// ---------- audio analysis (ffmpeg decode + FFT) ----------
export async function decode(webm: Uint8Array): Promise<Float32Array> {
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  p.stdin.write(webm); p.stdin.end()
  const buf = new Int16Array((await new Response(p.stdout).arrayBuffer()).slice(0))
  return Float32Array.from(buf, (v) => v / 32768)
}
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]] } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k)
      const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
      re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
    }
  }
}
export interface Analysis { seconds: number; peakRms: number; freqs: number[]; onsetSec: number | null }
const SR = 48000
export function analyse(x: Float32Array): Analysis {
  const win = 960 // 20 ms
  let peak = 0, peakAt = 0, onset: number | null = null
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0; for (let k = 0; k < win; k++) s += x[i + k] * x[i + k]
    const r = Math.sqrt(s / win)
    if (r > peak) { peak = r; peakAt = i }
    if (onset === null && r > 0.05) onset = i / SR
  }
  const N = 16384
  const start = Math.max(0, Math.min(x.length - N, peakAt - N / 2))
  const re = new Float64Array(N), im = new Float64Array(N)
  for (let i = 0; i < N && start + i < x.length; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
  fft(re, im)
  const mag = Array.from({ length: N / 2 }, (_, i) => Math.hypot(re[i], im[i]))
  const top = Math.max(...mag, 1e-9)
  const freqs: number[] = []
  for (let i = 3; i < N / 2 - 1; i++) if (mag[i] > top * 0.3 && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) freqs.push(Math.round(i * SR / N))
  return { seconds: x.length / SR, peakRms: peak, freqs: freqs.slice(0, 4), onsetSec: onset }
}

// ---------- stats ----------
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
export const p95 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : NaN }

// ---------- process tree cpu / rss (descendants of the browser pid only) ----------
const cpuSecs = (t: string) => { return t.split(":").reduce((s, x) => s * 60 + Number(x), 0) }
export interface TreeSample { cpu: Map<number, number>; rssMb: number }
export async function treeStats(root: number): Promise<TreeSample> {
  const out = await new Response(Bun.spawn(['ps', '-axo', 'pid=,ppid=,cputime=,rss='], { stdout: 'pipe' }).stdout).text()
  const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, t, rss]) => ({ pid: +pid, ppid: +ppid, cpu: cpuSecs(t), rss: +rss }))
  const mine = new Set([root]); let grew = true
  while (grew) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true } }
  const sel = rows.filter((r) => mine.has(r.pid))
  return { cpu: new Map(sel.map((r) => [r.pid, r.cpu])), rssMb: sel.reduce((s, r) => s + r.rss, 0) / 1024 }
}
/** CPU seconds burnt between two samples: per-pid deltas (a process that exited in between cannot make the total negative). */
export const cpuDelta = (a: TreeSample, b: TreeSample) => [...b.cpu].reduce((s, [pid, c]) => s + c - (a.cpu.get(pid) ?? 0), 0)
