// Jendela bergulir latensi input->frame per node browser (I1-d). Murni dan tanpa alokasi di jalur frame:
// ring Float64Array dialokasikan sekali; persentil dihitung hanya saat chip membaca (bukan per frame).
// Tiru Orca typing-latency: persentil nearest-rank (diagnostic-summary.ts:15-23), ledakan input = satu sampel.
import { INPUT_LATENCY_STALE_MS } from '../../../shared/browser.contract'
import type { ClientMsg, FrameLatency } from '../../../shared/browser.contract'

/** Anggaran input->frame (ms): <= good hijau, <= warn kuning, di atasnya merah. Dinilai pada p95. */
export const LATENCY_BUDGET_MS = { good: 50, warn: 100 } as const
/** Jumlah sampel terakhir yang dihitung persentilnya. */
export const LATENCY_WINDOW_SIZE = 64
/** Tanpa sampel baru selama ini = idle: chip disembunyikan. */
export const LATENCY_IDLE_MS = 3000

/**
 * Tahap yang benar-benar terukur. Satu arah klien->server TIDAK terukur tanpa sinkron jam, jadi `network` =
 * total - tahap lain = kirim + kembali. `dispatchToSwap` & `swapToServer` memakai jam mesin server (= jam Chromium).
 */
export const LATENCY_STAGES = ['network', 'rxToDispatch', 'dispatchToSwap', 'swapToServer', 'clientPaint'] as const
export type LatencyStage = (typeof LATENCY_STAGES)[number]

export type LatencyTone = 'good' | 'warn' | 'bad'

export interface LatencyWindow {
  readonly total: Float64Array
  readonly stages: Record<LatencyStage, Float64Array>
  readonly scratch: Float64Array
  count: number
  next: number
  /** Jam klien (epoch ms) saat sampel terakhir dicatat; 0 = belum pernah. */
  lastAt: number
}

export interface LatencySummary {
  p50: number
  p95: number
  tone: LatencyTone
  count: number
  /** p50 per tahap. */
  stages: Record<LatencyStage, number>
}

/** Jam epoch ms milik klien; sama dengan yang dicapkan di `ls`, jadi total diukur di satu jam. */
export const clientNow = (): number => performance.timeOrigin + performance.now()

export function createLatencyWindow(size = LATENCY_WINDOW_SIZE): LatencyWindow {
  const stages = {} as Record<LatencyStage, Float64Array>
  for (const s of LATENCY_STAGES) stages[s] = new Float64Array(size)
  return { total: new Float64Array(size), stages, scratch: new Float64Array(size), count: 0, next: 0, lastAt: 0 }
}

/** Input yang biasanya mengubah layar. Mousemove/keyup dilewati: sering tanpa frame, jadi hanya menahan sampel. */
export function wantsStamp(m: ClientMsg): boolean {
  switch (m.t) {
    case 'mouse': return m.type !== 'move'
    case 'key': return m.type === 'down'
    case 'text': case 'ime': case 'touch': return true
    default: return false
  }
}

/**
 * Catat satu frame yang membawa `lat` (frame pertama sesudah input, dicocokkan server lewat `metadata.timestamp`).
 * `rxAt`/`paintAt` = jam klien. Dibuang (false) bila tak masuk akal: `ls` dari jam lain (penonton di mesin lain)
 * atau sisa jaringan negatif.
 */
export function recordFrame(w: LatencyWindow, lat: FrameLatency, rxAt: number, paintAt: number): boolean {
  const total = paintAt - lat.ls
  const clientPaint = paintAt - rxAt
  const network = total - lat.rxToDispatch - lat.dispatchToSwap - lat.swapToServer - clientPaint
  if (!(total >= 0 && total <= INPUT_LATENCY_STALE_MS * 2 && network >= 0)) return false
  const i = w.next
  w.total[i] = total
  w.stages.network[i] = network
  w.stages.rxToDispatch[i] = lat.rxToDispatch
  w.stages.dispatchToSwap[i] = lat.dispatchToSwap
  w.stages.swapToServer[i] = lat.swapToServer
  w.stages.clientPaint[i] = clientPaint
  w.next = (i + 1) % w.total.length
  if (w.count < w.total.length) w.count++
  w.lastAt = paintAt
  return true
}

/** Persentil nearest-rank dari `n` nilai pertama `values` (pakai `scratch`, tak mengubah `values`). */
export function percentile(values: Float64Array, n: number, fraction: number, scratch: Float64Array): number {
  if (n === 0) return NaN
  for (let i = 0; i < n; i++) scratch[i] = values[i]
  const sorted = scratch.subarray(0, n).sort()
  const rank = Math.ceil(fraction * n)
  return sorted[Math.min(n - 1, Math.max(0, rank - 1))]
}

export function toneOf(ms: number): LatencyTone {
  return ms <= LATENCY_BUDGET_MS.good ? 'good' : ms <= LATENCY_BUDGET_MS.warn ? 'warn' : 'bad'
}

/** Ringkasan untuk chip; null bila belum ada sampel atau idle (tak ada sampel dalam LATENCY_IDLE_MS). */
export function summarize(w: LatencyWindow, now: number): LatencySummary | null {
  if (w.count === 0 || now - w.lastAt > LATENCY_IDLE_MS) return null
  const p95 = percentile(w.total, w.count, 0.95, w.scratch)
  const stages = {} as Record<LatencyStage, number>
  for (const s of LATENCY_STAGES) stages[s] = percentile(w.stages[s], w.count, 0.5, w.scratch)
  return { p50: percentile(w.total, w.count, 0.5, w.scratch), p95, tone: toneOf(p95), count: w.count, stages }
}
