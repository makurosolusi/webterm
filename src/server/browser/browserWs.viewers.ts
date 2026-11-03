// Penonton per node untuk /ws/browser: screencast mulai pada penonton pertama dan berhenti pada yang terakhir,
// frame di-fanout dengan backpressure per (klien,node), ack ke host baru setelah SEMUA penerima frame meng-ack.
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
}

/** Ujung tulis satu klien; implementasi nyata membungkus `ws`. */
export interface ViewerSink {
  readonly bufferedAmount: number
  /** false bila socket tidak lagi terbuka (frame dianggap dibuang). */
  sendBinary(bytes: Uint8Array): boolean
  sendJson(msg: ServerMsg): void
}

/** Satu koneksi klien; identitas objek dipakai sebagai kunci. */
export interface Viewer { readonly sink: ViewerSink }

interface NodeEntry {
  viewers: Map<Viewer, FrameGate>
  /** seq -> penonton yang belum meng-ack; kosong = ack diteruskan ke host. */
  pending: Map<number, Set<Viewer>>
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
  const stateMsg = (nodeId: string) => { const s = host.state(nodeId); return s ? withLease(s) : null }

  function subscribe() {
    if (unsubs.length) return
    unsubs = [
      host.onState((s) => onState(s)),
      host.onEvent((e) => {
        if (e.k === 'dialog') broadcast(e.nodeId, { t: 'dialog', id: e.nodeId, kind: e.kind, message: e.message, defaultPrompt: e.defaultPrompt })
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
      e.pending.clear()
      for (const g of e.viewers.values()) g.clear()
    } else if (s.live === 'live' && e.viewers.size > 0 && !e.casting) {
      sync(s.id).catch((err) => log.warn('browser.ws', 'restart screencast failed', { ids: { nodeId: s.id }, error: errName(err) }))
    }
    broadcast(s.id, withLease(s))
  }

  function fanout(nodeId: string, f: Frame) {
    const e = nodes.get(nodeId)
    const to = new Set<Viewer>()
    let bytes: Uint8Array | undefined
    for (const [v, gate] of e?.viewers ?? []) {
      if (gate.admit(f.seq, v.sink.bufferedAmount) === 'drop') continue
      bytes ??= encodeFrame(nodeId, f.seq, f.jpeg)
      if (v.sink.sendBinary(bytes)) to.add(v)
      else gate.ack(f.seq)
    }
    // ponytail: frame yang dibuang langsung di-ack ke host; bila itu frame terakhir sebelum halaman diam, klien lambat
    // melihat frame basi sampai perubahan visual berikut. Upgrade: simpan 1 frame terbaru per penonton, kirim saat ack.
    if (to.size === 0 || !e) host.ackFrame(nodeId, f.seq)
    else e.pending.set(f.seq, to)
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

  /** Lepas jatah in-flight penonton; seq yang tak lagi menunggu siapa pun di-ack ke host. */
  function release(nodeId: string, e: NodeEntry, v: Viewer, seqs: number[]) {
    for (const seq of seqs) {
      const set = e.pending.get(seq)
      if (!set) continue
      set.delete(v)
      if (set.size === 0) { e.pending.delete(seq); host.ackFrame(nodeId, seq) }
    }
  }

  return {
    join(nodeId, v) {
      let e = nodes.get(nodeId)
      if (!e) nodes.set(nodeId, (e = { viewers: new Map(), pending: new Map(), casting: false }))
      if (e.viewers.has(v)) return
      const first = e.viewers.size === 0
      e.viewers.set(v, createFrameGate())
      subscribe()
      if (first) setVisible?.(nodeId, true)
    },
    async leave(nodeId, v) {
      const e = nodes.get(nodeId)
      const gate = e?.viewers.get(v)
      if (!e || !gate) return
      release(nodeId, e, v, gate.clear())
      e.viewers.delete(v)
      if (e.viewers.size === 0) setVisible?.(nodeId, false)
      unsubscribeIfIdle()
      await sync(nodeId)
    },
    ack(nodeId, v, seq) {
      const e = nodes.get(nodeId)
      if (e?.viewers.get(v)?.ack(seq)) release(nodeId, e, v, [seq])
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
