// Penonton per node untuk /ws/browser: screencast mulai pada penonton pertama dan berhenti pada yang terakhir.
// Frame di-ack ke host SAAT DITERIMA (DevTools ScreenCaptureModel.ts:154-155) supaya produksi frame Chromium tak
// terikat round-trip klien; tiap penonton memegang SATU frame tertunda, frame terbaru menimpa yang lama, dikirim saat
// `ws.send` sebelumnya selesai atau klien meng-ack (Steel page-screencast.ts:146-168,200-232: deliver/flush/send).
import { encodeFrame } from '../../shared/browser.wire'
import type { BrowserHostApi, BrowserState, Frame, LeaseView, ServerMsg } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { createFrameGate } from './browserWs.backpressure'
import type { FrameGate } from './browserWs.backpressure'
import type { HostEvent } from './browserHost.targets'

const log = createLogger('browser.ws')
const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e)

/** Host yang dipakai gateway: `BrowserHostApi` + tambahan `BrowserHost` (dialog, galat, nav non-URL, salin). */
export interface GatewayHost extends BrowserHostApi {
  onEvent(cb: (e: HostEvent) => void): () => void
  answerDialog(nodeId: string, accept: boolean, text?: string): Promise<void>
  navAction(nodeId: string, action: 'go' | 'back' | 'forward' | 'reload' | 'stop', url?: string): Promise<void>
  selectionText(nodeId: string): Promise<string>
  /** Sakelar Shields situs halaman node (persist per host) lalu muat ulang. */
  setShields(nodeId: string, on: boolean): Promise<void>
}

/** Ujung tulis satu klien; implementasi nyata membungkus `ws`. */
export interface ViewerSink {
  readonly bufferedAmount: number
  /** false bila socket tidak lagi terbuka (frame dianggap dibuang); `done` dipanggil saat tulisan selesai. */
  sendBinary(bytes: Uint8Array, done?: () => void): boolean
  sendJson(msg: ServerMsg): void
}

/** Satu koneksi klien; identitas objek dipakai sebagai kunci. */
export interface Viewer { readonly sink: ViewerSink }

/** Jatah kirim satu (klien,node) + satu frame terbaru yang belum terkirim. */
interface Slot { gate: FrameGate; pending?: { seq: number; bytes: Uint8Array } }

interface NodeEntry {
  viewers: Map<Viewer, Slot>
  casting: boolean
}

export interface ViewerHub {
  /** Daftarkan penonton (idempoten); screencast dimulai lewat `sync`. */
  join(nodeId: string, v: Viewer): void
  leave(nodeId: string, v: Viewer): Promise<void>
  ack(nodeId: string, v: Viewer, seq: number): void
  /** Samakan screencast dengan jumlah penonton (serial per node); melempar bila host gagal. */
  sync(nodeId: string): Promise<void>
  /** Siarkan state terkini node (dipanggil juga oleh pengubah lease di luar host). */
  refreshState(nodeId: string): void
  stateMsg(nodeId: string): ServerMsg | null
  /** Jumlah penonton node (uji/diagnosis). */
  count(nodeId: string): number
}

/** Hub bersama semua koneksi; satu per proses. Langganan host hanya hidup selama ada penonton. */
export function createViewerHub(host: GatewayHost, leases: LeaseView, setVisible?: (nodeId: string, visible: boolean) => void): ViewerHub {
  const nodes = new Map<string, NodeEntry>()
  const tails = new Map<string, Promise<void>>()
  let unsubs: Array<() => void> = []

  const withLease = (s: BrowserState): ServerMsg => ({ t: 'state', ...s, lease: leases.holder(s.id) })
  const broadcast = (nodeId: string, msg: ServerMsg) => {
    for (const v of nodes.get(nodeId)?.viewers.keys() ?? []) v.sink.sendJson(msg)
  }
  const firstViewer = (nodeId: string): Viewer | undefined => nodes.get(nodeId)?.viewers.keys().next().value
  const stateMsg = (nodeId: string) => { const s = host.state(nodeId); return s ? withLease(s) : null }

  function subscribe() {
    if (unsubs.length) return
    unsubs = [
      host.onState((s) => onState(s)),
      host.onEvent((e) => {
        if (e.k === 'dialog') broadcast(e.nodeId, { t: 'dialog', id: e.nodeId, kind: e.kind, message: e.message, defaultPrompt: e.defaultPrompt })
        else if (e.k === 'popup') firstViewer(e.nodeId)?.sink.sendJson({ t: 'popup', id: e.nodeId, url: e.url }) // satu klien saja: tiap klien yang menerima akan membuat node
        else broadcast(e.nodeId, { t: 'error', id: e.nodeId, code: e.code, hostname: e.hostname })
      }),
    ]
  }
  function unsubscribeIfIdle() {
    if ([...nodes.values()].some((e) => e.viewers.size > 0)) return
    for (const u of unsubs) u()
    unsubs = []
  }

  function onState(s: BrowserState) {
    const e = nodes.get(s.id)
    if (!e) return
    if (s.live === 'discarded') { // target hilang (crash/discard): screencast lama mati, ack lama tak berarti
      e.casting = false
      for (const slot of e.viewers.values()) { slot.gate.clear(); slot.pending = undefined }
    } else if (s.live === 'live' && e.viewers.size > 0 && !e.casting) {
      sync(s.id).catch((err) => log.warn('browser.ws', 'restart screencast failed', { ids: { nodeId: s.id }, error: errName(err) }))
    }
    broadcast(s.id, withLease(s))
  }

  function fanout(nodeId: string, f: Frame) {
    host.ackFrame(nodeId, f.seq) // ack saat diterima: Chromium lanjut memproduksi tanpa menunggu klien
    const e = nodes.get(nodeId)
    if (!e || e.viewers.size === 0) return
    const bytes = encodeFrame(nodeId, f.seq, f.jpeg, f.lat)
    for (const [v, slot] of e.viewers) {
      slot.pending = { seq: f.seq, bytes } // terbaru menimpa: klien lambat tetap melihat frame terakhir, bukan yang basi
      flush(v, slot)
    }
  }

  /** Kirim frame tertunda bila jatah klien (MAX_FRAMES_IN_FLIGHT belum di-ack, buffer socket) masih ada. */
  // ponytail: buffer penuh karena node LAIN di socket yang sama tidak memicu flush; frame tertunda node ini menunggu
  // frame/ack berikutnya. Upgrade: flush semua slot penonton dari callback tulis apa pun bila terlihat basi.
  function flush(v: Viewer, slot: Slot) {
    const p = slot.pending
    if (!p || slot.gate.admit(p.seq, v.sink.bufferedAmount) === 'drop') return
    slot.pending = undefined
    if (!v.sink.sendBinary(p.bytes, () => flush(v, slot))) slot.gate.ack(p.seq) // socket tertutup: frame dibuang
  }

  async function reconcile(nodeId: string) {
    const e = nodes.get(nodeId)
    if (!e) return
    const want = e.viewers.size > 0
    if (want === e.casting) return
    e.casting = want
    try {
      if (want) await host.startScreencast(nodeId, (f) => fanout(nodeId, f))
      else await host.stopScreencast(nodeId)
    } catch (err) {
      e.casting = !want // gagal: kondisi nyata tidak berubah, percobaan berikut boleh mengulang
      throw err
    }
  }

  function sync(nodeId: string): Promise<void> {
    const next = (tails.get(nodeId) ?? Promise.resolve()).then(() => reconcile(nodeId))
    const settled = next.then(() => undefined, () => undefined) // galat sampai ke pemanggil lewat `next`; rantai tak boleh macet
    tails.set(nodeId, settled)
    void settled.then(() => {
      if (tails.get(nodeId) !== settled) return
      tails.delete(nodeId)
      if (nodes.get(nodeId)?.viewers.size === 0) nodes.delete(nodeId)
    })
    return next
  }

  return {
    join(nodeId, v) {
      let e = nodes.get(nodeId)
      if (!e) nodes.set(nodeId, (e = { viewers: new Map(), casting: false }))
      if (e.viewers.has(v)) return
      const first = e.viewers.size === 0
      e.viewers.set(v, { gate: createFrameGate() })
      subscribe()
      if (first) setVisible?.(nodeId, true)
    },
    async leave(nodeId, v) {
      const e = nodes.get(nodeId)
      const slot = e?.viewers.get(v)
      if (!e || !slot) return
      slot.pending = undefined // callback `ws.send` yang masih jalan tak boleh mengirim frame node yang sudah dilepas
      e.viewers.delete(v)
      if (e.viewers.size === 0) setVisible?.(nodeId, false)
      unsubscribeIfIdle()
      await sync(nodeId)
    },
    ack(nodeId, v, seq) {
      const slot = nodes.get(nodeId)?.viewers.get(v)
      if (slot?.gate.ack(seq)) flush(v, slot)
    },
    sync,
    refreshState(nodeId) {
      const m = stateMsg(nodeId)
      if (m) broadcast(nodeId, m)
    },
    stateMsg,
    count: (nodeId) => nodes.get(nodeId)?.viewers.size ?? 0,
  }
}
