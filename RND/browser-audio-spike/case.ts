// SPIKE: jangan merge ke produk. Satu kasus uji = satu target baru: inject + binding + (opsional) screencast, kumpulkan chunk, dekode, analisis.
import { type Browser, type Servers, CDP, CDP_EVENT, newPage, closePage, evalIn, waitLoad, click, sleep, decode, analyse, type Analysis } from './harness'
import { injectSource, BINDING, type InjectOpts } from './inject.source'

export interface Chunk { f: string; s: number; t: number; ts: number; n: number; arr: number; bytes: Uint8Array }
export interface Frame { arr: number; bytes: number }
export interface Cap { chunks: Chunk[]; starts: Array<{ f: string; arr: number; state: string; url: string; mime: string }>; logs: string[]; frames: Frame[]; attached: string[]; childSids: string[] }
export interface CaseOpts {
  scenario: string
  qs?: string // extra query params
  inject: InjectOpts | null
  gesture?: boolean // real user activation via Input.dispatchMouseEvent before the scenario
  csp?: boolean
  screencast?: boolean
  autoAttach?: boolean // Target.setAutoAttach flatten (OOPIF)
  originB?: boolean // load the top page from the localhost origin
  settle?: number
  /** called after the scenario promise resolves, while the page is still alive */
  after?: (b: Browser, sid: string, cap: Cap) => Promise<void>
  keep?: boolean
}
export interface CaseResult { cap: Cap; page: unknown; err?: string; streams: Map<string, Uint8Array>; analysis: Map<string, Analysis>; sid: string; closeFn: () => Promise<void> }

const routes = new WeakMap<Browser, Map<string, Cap>>()
function routerFor(b: Browser): Map<string, Cap> {
  let m = routes.get(b)
  if (m) return m
  routes.set(b, (m = new Map()))
  const caps = m
  b.cdp.on(CDP_EVENT.bindingCalled, (p, sid) => {
    const cap = caps.get(sid ?? '')
    if (!cap || p.name !== BINDING) return
    const arr = Date.now()
    const msg = JSON.parse(String(p.payload))
    if (msg.k === 'c') cap.chunks.push({ f: msg.f, s: msg.s, t: msg.t, ts: msg.ts, n: msg.n, arr, bytes: Uint8Array.from(Buffer.from(msg.d, 'base64')) })
    else if (msg.k === 's') cap.starts.push({ f: msg.f, arr, state: msg.state, url: msg.url, mime: msg.mime })
    else cap.logs.push(`${msg.f}: ${msg.m}`)
  })
  b.cdp.on(CDP_EVENT.exceptionThrown, (p, sid) => {
    const cap = caps.get(sid ?? '')
    const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (cap) cap.logs.push('exception: ' + (d?.exception?.description ?? d?.text ?? '?').slice(0, 160))
  })
  b.cdp.on(CDP_EVENT.screencastFrame, (p, sid) => {
    const cap = caps.get(sid ?? '')
    if (!cap) return
    cap.frames.push({ arr: Date.now(), bytes: String(p.data).length * 0.75 })
    b.cdp.send(CDP.screencastFrameAck, { sessionId: p.sessionId }, sid).catch(() => undefined)
  })
  b.cdp.on(CDP_EVENT.attachedToTarget, (p, parentSid) => {
    const child = String(p.sessionId)
    const cap = caps.get(parentSid ?? '')
    if (!cap) return
    const info = p.targetInfo as { type: string; url: string }
    cap.attached.push(`${info.type}:${info.url.slice(0, 40)}:wait=${p.waitingForDebugger}`)
    caps.set(child, cap)
    cap.childSids.push(child)
    const inj = injections.get(cap)
    void (async () => {
      if (info.type === 'iframe') {
        await b.cdp.send(CDP.pageEnable, {}, child)
        await b.cdp.send(CDP.runtimeEnable, {}, child)
        await b.cdp.send(CDP.addBinding, { name: BINDING }, child)
        if (inj) await b.cdp.send(CDP.addScript, { source: inj, runImmediately: true }, child)
        await b.cdp.send(CDP.setAutoAttach, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child)
      }
      if (p.waitingForDebugger === true) await b.cdp.send(CDP.runIfWaiting, {}, child)
    })().catch((e) => cap.logs.push('attach fail ' + e.message))
  })
  return m
}
const injections = new WeakMap<Cap, string>()

export const emptyCap = (): Cap => ({ chunks: [], starts: [], logs: [], frames: [], attached: [], childSids: [] })

export async function runCase(b: Browser, sv: Servers, o: CaseOpts): Promise<CaseResult> {
  const caps = routerFor(b)
  const cap = emptyCap()
  const src = o.inject ? injectSource(o.inject) : null
  if (src) injections.set(cap, src)
  const page = await newPage(b, async (sid) => {
    caps.set(sid, cap)
    await b.cdp.send(CDP.runtimeEnable, {}, sid)
    await b.cdp.send(CDP.addBinding, { name: BINDING }, sid)
    if (src) await b.cdp.send(CDP.addScript, { source: src }, sid)
    if (o.autoAttach) await b.cdp.send(CDP.setAutoAttach, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid)
    if (o.screencast) await b.cdp.send(CDP.startScreencast, { format: 'jpeg', quality: 60, everyNthFrame: 1 }, sid)
  })
  const origin = o.originB ? `http://localhost:${sv.b}` : `http://127.0.0.1:${sv.a}`
  const url = `${origin}/page.html?b=${o.originB ? sv.a : sv.b}${o.csp ? '&csp=1' : ''}${o.qs ? '&' + o.qs : ''}`
  let pageRes: unknown, err: string | undefined
  try {
    await waitLoad(b, page.sid, url)
    if (o.gesture) await click(b, page.sid)
    pageRes = await evalIn(b, page.sid, `runScenario(${JSON.stringify(o.scenario)})`)
    await sleep(o.settle ?? 600)
    if (o.after) await o.after(b, page.sid, cap)
  } catch (e) { err = e instanceof Error ? e.message : String(e) }
  const streams = new Map<string, Uint8Array>()
  for (const f of new Set(cap.chunks.map((c) => c.f))) {
    const parts = cap.chunks.filter((c) => c.f === f).sort((x, y) => x.s - y.s).map((c) => c.bytes)
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let off = 0
    for (const p of parts) { all.set(p, off); off += p.length }
    streams.set(f, all)
  }
  const analysis = new Map<string, Analysis>()
  for (const [f, bytes] of streams) analysis.set(f, analyse(await decode(bytes)))
  const closeFn = async () => { await closePage(b, page); for (const [k, v] of caps) if (v === cap) caps.delete(k) }
  if (!o.keep) await closeFn()
  return { cap, page: pageRes, err, streams, analysis, sid: page.sid, closeFn }
}

/** Pass = some stream carries a tone at `freq` (+-12 Hz) above the silence threshold. */
export function hasTone(r: CaseResult, freq = 440): { ok: boolean; freq: number | null; peakRms: number; streams: number; bytes: number } {
  let best: { freq: number | null; peakRms: number } = { freq: null, peakRms: 0 }
  for (const a of r.analysis.values()) if (a.freqs.some((f) => Math.abs(f - freq) < 12) && a.peakRms > best.peakRms) best = { freq, peakRms: a.peakRms }
  const loudest = [...r.analysis.values()].sort((x, y) => y.peakRms - x.peakRms)[0]
  return { ok: best.freq !== null && best.peakRms > 0.05, freq: best.freq ?? loudest?.freqs[0] ?? null, peakRms: best.peakRms || (loudest?.peakRms ?? 0), streams: r.streams.size, bytes: [...r.streams.values()].reduce((s, x) => s + x.length, 0) }
}
