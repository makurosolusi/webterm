// SPIKE: jangan merge ke produk. Suite pengukuran: latensi/A-V, bitrate+laju chunk, CPU/RSS, throttling/lifecycle, ketersediaan MediaRecorder.
import { type Browser, CDP, median, p95, sleep, treeStats, cpuDelta, type TreeSample, decode, analyse, evalIn } from './harness'
import { runCase, type CaseResult, type Cap } from './case'
import type { InjectOpts } from './inject.source'
import type { Ctx, Row } from './suites'

const f1 = (x: number) => +x.toFixed(1)

/** First chunk (by arrival) whose cumulative decode contains tone onset; returns that chunk's arrival time. */
async function detectChunk(r: CaseResult, T0: number): Promise<number | null> {
  const cs = [...r.cap.chunks].sort((a, b) => a.s - b.s)
  const startIdx = Math.max(0, cs.findIndex((c) => c.arr >= T0) - 1)
  for (let i = startIdx; i < cs.length; i++) {
    const all = new Uint8Array(cs.slice(0, i + 1).reduce((s, c) => s + c.bytes.length, 0)); let off = 0
    for (const c of cs.slice(0, i + 1)) { all.set(c.bytes, off); off += c.bytes.length }
    const a = analyse(await decode(all))
    if (a.onsetSec !== null && a.peakRms > 0.05) return cs[i].arr
  }
  return null
}
/** First screencast frame after T0 that is far smaller than the pre-T0 frames (solid red vs noise). */
function detectFrame(cap: Cap, T0: number): number | null {
  const pre = cap.frames.filter((f) => f.arr < T0).map((f) => f.bytes)
  if (!pre.length) return null
  const big = Math.max(...pre)
  return cap.frames.find((f) => f.arr >= T0 && f.bytes < big * 0.3)?.arr ?? null
}

export async function latency(c: Ctx, via: 'osc' | 'el', inject: InjectOpts): Promise<Row> {
  const aud: number[] = [], vis: number[] = [], av: number[] = [], transit: number[] = [], rec: number[] = []
  let miss = 0
  for (let i = 0; i < (c.n === 1 ? 2 : Math.max(c.n, 10)); i++) {
    const r = await runCase(c.b, c.sv, { scenario: 'latency', qs: `via=${via}`, inject, screencast: true })
    const T0 = (r.page as { T0?: number } | undefined)?.T0
    if (!T0) { miss++; continue }
    const a = await detectChunk(r, T0), v = detectFrame(r.cap, T0)
    if (a === null || v === null) { miss++; continue }
    aud.push(a - T0); vis.push(v - T0); av.push(a - v)
    for (const ch of r.cap.chunks) { transit.push(ch.arr - ch.ts); rec.push(ch.ts - ch.t) }
  }
  return {
    browser: c.label, source: via, mode: inject.mode, timesliceMs: inject.timeslice, runs: aud.length, missed: miss,
    audioMedianMs: f1(median(aud)), audioP95Ms: f1(p95(aud)), visualMedianMs: f1(median(vis)), visualP95Ms: f1(p95(vis)),
    avSkewMedianMs: f1(median(av)), avSkewP95Ms: f1(p95(av)), avMin: f1(Math.min(...av)), avMax: f1(Math.max(...av)),
    bindingTransitMedianMs: f1(median(transit)), bindingTransitP95Ms: f1(p95(transit)), b64EncodeMedianMs: f1(median(rec)),
  }
}

/** Chunk rate + effective bitrate on music-like content. bytes are raw webm payload (the CDP binding string is ~1.33x). */
export async function bitrate(c: Ctx): Promise<Row[]> {
  const rows: Row[] = []
  for (const ts of [100, 250]) for (const br of [undefined, 64000, 32000]) {
    const kb: number[] = [], cps: number[] = [], sz: number[] = [], jit: number[] = []
    for (let i = 0; i < Math.min(c.n, 5); i++) {
      const r = await runCase(c.b, c.sv, { scenario: 'noisy', inject: { mode: 'mes', timeslice: ts, bitrate: br } })
      const cs = r.cap.chunks.sort((a, b) => a.s - b.s)
      if (cs.length < 3) continue
      const span = (cs.at(-1)!.arr - cs[0].arr) / 1000
      const bytes = cs.reduce((s, x) => s + x.n, 0)
      kb.push(bytes * 8 / 1000 / (r.analysis.values().next().value?.seconds ?? span)); cps.push((cs.length - 1) / span)
      sz.push(bytes / cs.length)
      for (let k = 1; k < cs.length; k++) jit.push(cs[k].arr - cs[k - 1].arr)
    }
    rows.push({ browser: c.label, timesliceMs: ts, audioBitsPerSecond: br ?? 'default', chunksPerSec: f1(median(cps)), avgChunkBytes: Math.round(median(sz)), effectiveKbps: f1(median(kb)), interArrivalP95Ms: f1(p95(jit)), base64Kbps: f1(median(kb) * 1.334) })
  }
  return rows
}

/** CPU (descendants of our browser pid; ps cputime deltas over 8 s) and RSS, with/without capture; interleaved to cancel drift. */
export async function cpu(c: Ctx, pid: number): Promise<Row[]> {
  const conds: Array<[string, string, InjectOpts | null]> = [
    ['silent page, no inject', 'none', null], ['silent page, inject', 'none', { mode: 'mes', timeslice: 100 }],
    ['osc tone, no inject', 'osc', null], ['osc tone, inject (tee)', 'osc', { mode: 'mes', timeslice: 100 }],
    ['<audio> loop, no inject', 'el', null], ['<audio> loop, inject mes', 'el', { mode: 'mes', timeslice: 100 }], ['<audio> loop, inject cap', 'el', { mode: 'cap', timeslice: 100 }],
  ]
  const acc = new Map<string, { cpu: number[]; rss: number[] }>(conds.map(([n]) => [n, { cpu: [], rss: [] }]))
  const reps = Math.max(3, Math.min(c.n, 4))
  for (let i = 0; i < reps; i++) for (const [name, src, inj] of conds) {
    let s0: TreeSample = { cpu: new Map(), rssMb: 0 }, s1 = s0
    await runCase(c.b, c.sv, {
      scenario: 'hold', qs: `src=${src}`, inject: inj, screencast: true, settle: 1500, keep: false,
      after: async () => { s0 = await treeStats(pid); await sleep(8000); s1 = await treeStats(pid) },
    })
    const wall = 8 // sampled interval, page setup excluded
    acc.get(name)!.cpu.push(cpuDelta(s0, s1) / wall * 100); acc.get(name)!.rss.push(s1.rssMb)
  }
  return conds.map(([name]) => { const a = acc.get(name)!; return { browser: c.label, condition: name, runs: a.cpu.length, cpuPctOfOneCoreMedian: f1(median(a.cpu)), cpuRuns: a.cpu.map(f1).join(' '), rssMbMedian: Math.round(median(a.rss)), rssRuns: a.rss.map(Math.round).join(' ') } })
}

/** Chunk flow while the node is "hidden": focus emulation off, lifecycle frozen/active, and what visibilityState says. */
export async function throttle(c: Ctx): Promise<Row[]> {
  const rows: Row[] = []
  const win = 4000
  const chunksIn = async (r: { cap: Cap }, ms: number) => { const n0 = r.cap.chunks.length; await sleep(ms); return r.cap.chunks.length - n0 }
  const steps: Array<[string, (b: Browser, sid: string) => Promise<void>]> = [
    ['baseline (offscreen/minimized window)', async () => undefined],
    ['setFocusEmulationEnabled=false', async (b, sid) => { await b.cdp.send(CDP.setFocusEmulation, { enabled: false }, sid) }],
    ['setWebLifecycleState=frozen', async (b, sid) => { await b.cdp.send(CDP.setFocusEmulation, { enabled: true }, sid); await b.cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, sid) }],
    ['setWebLifecycleState=active (resume)', async (b, sid) => { await b.cdp.send('Page.setWebLifecycleState', { state: 'active' }, sid) }],
  ]
  const probe = (b: Browser, sid: string) => Promise.race([evalIn<number>(b, sid, 'window.__ticks'), sleep(1000).then(() => -1)])
  const r = await runCase(c.b, c.sv, {
    scenario: 'hold', qs: 'src=osc', inject: { mode: 'mes', timeslice: 100 }, keep: true, settle: 500,
    after: async (b, sid, cp) => {
      const vis = await evalIn<string>(b, sid, 'document.visibilityState')
      await evalIn(b, sid, 'window.__ticks=0; setInterval(()=>window.__ticks++, 50); 1')
      for (const [name, fn] of steps) {
        let fail = ''
        await fn(b, sid).catch((e) => { fail = String(e.message).slice(0, 90) })
        await sleep(300)
        const t0 = await probe(b, sid).catch(() => -1)
        const n = await chunksIn({ cap: cp }, win)
        const t1 = await probe(b, sid).catch(() => -1)
        rows.push({ browser: c.label, state: name, visibilityState: vis, chunksPer4s: n, expected: 40, chunksPerSec: f1(n / 4), timerTicksPerSec: t0 < 0 || t1 < 0 ? 'n/a (no reply)' : f1((t1 - t0) / 4), ...(fail ? { cdpError: fail } : {}) })
      }
    },
  })
  await r.closeFn()
  return rows
}

/** MediaRecorder / AudioContext availability in this browser mode. */
export async function availability(c: Ctx): Promise<Row> {
  let v: any
  const r = await runCase(c.b, c.sv, {
    scenario: 'silent', inject: null, keep: true,
    after: async (b, sid) => { v = await evalIn(b, sid, `({ rec: MediaRecorder.isTypeSupported('audio/webm;codecs=opus'), recOgg: MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'), ac: typeof AudioContext, msd: typeof MediaStreamAudioDestinationNode, cap: typeof HTMLMediaElement.prototype.captureStream, ua: navigator.userAgent.replace(/\\(.*?\\)/,'(..)'), vis: document.visibilityState, baseLatency: new AudioContext().baseLatency, sr: new AudioContext().sampleRate, mse: MediaSource.isTypeSupported('audio/webm;codecs=opus') })`) },
  })
  await r.closeFn()
  return { browser: c.label, ...v }
}
