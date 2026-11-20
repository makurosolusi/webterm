// SPIKE: jangan merge ke produk. Suite fungsional: matriks sumber audio, autoplay, kegagalan (CSP/freeze/sandbox/banyak AudioContext).
import { type Browser, type Servers, median } from './harness'
import { runCase, hasTone, type CaseOpts, type CaseResult } from './case'
import type { InjectOpts } from './inject.source'

export type Row = Record<string, string | number | boolean>
export interface Ctx { b: Browser; sv: Servers; n: number; label: string }

const near = (x: unknown, v: number, tol = 0.15) => typeof x === 'number' && Math.abs(x - v) <= tol
/** Element side effects as the page saw them: it must still look like a normally playing element (ended fired, currentTime advanced). */
const elOk = (p: any) => !!p && p.endedEvent === true && near(p.currentTime, 1.4) && p.muted === false && p.volume === 1 && p.playError == null

interface Spec { name: string; scenario: string; opts?: Partial<CaseOpts>; side?: boolean; want?: number[] }
const SPECS: Spec[] = [
  { name: 'a1 blob: WAV <audio>', scenario: 'blobwav', side: true },
  { name: 'a2 MSE (MediaSource, WebM/Opus)', scenario: 'mse', side: true },
  { name: 'b WebAudio oscillator', scenario: 'osc' },
  { name: 'c1 <audio> cross-origin, NO CORS', scenario: 'xo_nocors', side: true },
  { name: 'c2 <audio> cross-origin, CORS (anonymous)', scenario: 'xo_cors', side: true },
  { name: 'd1 iframe same-site (other port)', scenario: 'iframe_same', opts: { autoAttach: true } },
  { name: 'd2 iframe cross-site OOPIF + autoAttach', scenario: 'iframe_oopif', opts: { autoAttach: true } },
  { name: 'd3 iframe cross-site, NO autoAttach', scenario: 'iframe_oopif' },
  { name: 'd4 sandboxed iframe, audio at its first script', scenario: 'iframe_sandbox', opts: { autoAttach: true } },
  { name: 'd5 sandboxed iframe, audio 700 ms later', scenario: 'iframe_sandbox_late', opts: { autoAttach: true } },
  { name: 'e1 new Audio() detached, started late', scenario: 'dyn_audio', side: true },
  { name: 'e2 <video> appended late', scenario: 'dyn_video', side: true },
  { name: 'e3 autoplay attribute, no play() call', scenario: 'autoplay_attr' },
  { name: 'g mix: osc 440 + <audio> 880', scenario: 'mix', want: [440, 880] },
  { name: 'f1 page freezes prototypes after inject', scenario: 'freeze', side: true },
  { name: 'f2 strict CSP (script-src self)', scenario: 'blobwav', opts: { csp: true }, side: true },
]

export async function matrix(c: Ctx, mode: InjectOpts['mode']): Promise<Row[]> {
  const rows: Row[] = []
  for (const s of SPECS) {
    const rs: CaseResult[] = []
    for (let i = 0; i < c.n; i++) rs.push(await runCase(c.b, c.sv, { scenario: s.scenario, inject: { mode, timeslice: 100 }, ...s.opts }))
    const tones = rs.map((r) => hasTone(r, 440))
    const mixOk = s.want ? rs.filter((r) => [...r.analysis.values()].some((a) => s.want!.every((f) => a.freqs.some((x) => Math.abs(x - f) < 12)))).length : null
    const pass = s.want ? mixOk! : tones.filter((t) => t.ok).length
    const side = s.side ? rs.filter((r) => elOk(r.page)).length : null
    rows.push({
      browser: c.label, mode, scenario: s.name, pass: `${pass}/${c.n}`,
      peakRms: +median(tones.map((t) => t.peakRms)).toFixed(3), freq: tones.find((t) => t.freq)?.freq ?? 'none',
      streams: median(tones.map((t) => t.streams)), kbps: +(median(tones.map((t, i) => t.bytes * 8 / 1000 / (rs[i].analysis.values().next().value?.seconds ?? 1))) || 0).toFixed(1),
      ...(side !== null ? { elementSideEffectsOk: `${side}/${c.n}` } : {}),
      ...(rs[0].cap.logs.length ? { log: rs[0].cap.logs[0] } : {}),
    })
  }
  return rows
}

/** Baseline: the same element scenarios with NO injection, to prove the side-effect fields (ended/currentTime) match. */
export async function baseline(c: Ctx): Promise<Row[]> {
  const rows: Row[] = []
  for (const s of SPECS.filter((x) => x.side)) {
    let ok = 0
    for (let i = 0; i < Math.min(c.n, 3); i++) ok += elOk((await runCase(c.b, c.sv, { scenario: s.scenario, inject: null, ...s.opts })).page) ? 1 : 0
    rows.push({ browser: c.label, scenario: s.name + ' (no inject)', elementSideEffectsOk: `${ok}/${Math.min(c.n, 3)}` })
  }
  return rows
}

/** Autoplay policy: what the page sees under webterm's flags (no autoplay flag) vs a real click (Emulation.setAutoplayPolicy does not exist in this Chrome build). */
export async function autoplay(c: Ctx): Promise<Row[]> {
  const rows: Row[] = []
  const variants: Array<[string, Partial<CaseOpts>]> = [['no gesture, default policy', {}], ['real click first (Input.dispatchMouseEvent)', { gesture: true }]]
  for (const [scn, label] of [['blobwav', '<audio>.play()'], ['osc', 'AudioContext osc'], ['autoplay_attr', 'autoplay attribute']] as const) {
    for (const [vname, vo] of variants) {
      const rs: CaseResult[] = []
      for (let i = 0; i < c.n; i++) rs.push(await runCase(c.b, c.sv, { scenario: scn, inject: { mode: 'mes', timeslice: 100 }, ...vo }))
      const tone = rs.filter((r) => hasTone(r).ok).length
      const errs = [...new Set(rs.map((r) => (r.page as any)?.playError ?? (r.page as any)?.ctxState ?? 'ok'))].join('/')
      rows.push({ browser: c.label, source: label, variant: vname, captured440: `${tone}/${c.n}`, pageSees: errs, busCtxState: [...new Set(rs.flatMap((r) => r.cap.starts.map((s) => s.state)))].join('/') || 'bus never created' })
    }
  }
  return rows
}

/** Failure modes: AudioContext count limit, with and without inject. */
export async function manyCtx(c: Ctx): Promise<Row[]> {
  const rows: Row[] = []
  for (const inj of [null, { mode: 'mes', timeslice: 100 } as InjectOpts]) {
    const rs: CaseResult[] = []
    for (let i = 0; i < Math.min(c.n, 3); i++) rs.push(await runCase(c.b, c.sv, { scenario: 'manyctx', qs: 'n=100', inject: inj }))
    const p = rs.map((r) => r.page as any)
    rows.push({ browser: c.label, inject: !!inj, contextsCreated: median(p.map((x) => x?.created ?? -1)), firstError: p[0]?.firstErr ?? 'none', running: median(p.map((x) => x?.running ?? -1)), streams: median(rs.map((r) => r.streams.size)) })
  }
  return rows
}
