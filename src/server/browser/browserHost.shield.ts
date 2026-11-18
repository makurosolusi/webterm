// Shields di atas CDP: intersep request halaman + iframe OOPIF (Fetch, tahap Request, putusan sinkron dari mesin
// filter) dan kebijakan popup. Popup TIDAK lagi menavigasi node pembuka: URL yang diblokir daftar filter ditutup
// diam-diam dan dihitung; sisanya jadi tab baru di node pembuka (`browserHost.tabs.popup.ts`), dibatasi per pembuka.
import type { BrowserState } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, ignoreClosed } from './cdp.client'
import type { CdpClient } from './cdp.client'
import type { AdblockVerdict } from './adblock.engine'
import type { ShieldPolicy } from './adblock.shields'
import { BrowserError } from './browserHost.targets'
import type { HostEvent, NodeRec, TargetTable } from './browserHost.targets'

const log = createLogger('browser.shields')

/** Popup sah maksimum yang diterima (jadi tab) per node pembuka dalam satu jendela waktu. */
export const POPUP_BURST_MAX = 3
/** Jendela waktu batas popup per pembuka. */
export const POPUP_BURST_WINDOW_MS = 10_000
const FETCH_PATTERNS = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }
// Hanya iframe (OOPIF iklan lintas situs) yang di-attach; worker/target lain tidak ditahan.
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] }
const PASS: AdblockVerdict = { block: false }
const BASE64_SUFFIX = ';base64'

export interface ShieldOps {
  table: TargetTable
  policy?: ShieldPolicy
  patch(rec: NodeRec, part: Partial<BrowserState>): void
  emit(e: HostEvent): void
  now?: () => number
}

export interface ShieldRouter {
  /** Pasang intersep + auto-attach iframe pada sesi halaman baru (no-op tanpa kebijakan). */
  enable(cdp: CdpClient, sessionId: string): Promise<void>
  /** `Fetch.requestPaused`: SELALU dijawab (lanjut/gagal/ganti), kalau tidak halaman menggantung. */
  paused(cdp: CdpClient, p: Record<string, unknown>, sessionId: string | undefined): void
  /** `Target.attachedToTarget` (iframe OOPIF): ikut diintersep lalu dilanjutkan. */
  attached(cdp: CdpClient, p: Record<string, unknown>, parentSession: string | undefined): void
  detached(p: Record<string, unknown>): void
  /** Popup dari `opener` dengan URL pertamanya: true = boleh jadi tab; false = diblokir dan dihitung (pemanggil menutup targetnya). */
  popupAllowed(opener: NodeRec, url: string): boolean
  /** Bagian state Shields untuk halaman baru di `url` (hitungan mulai dari nol). */
  pageState(url: string): Partial<BrowserState>
  /** Sakelar Shields untuk host halaman `rec` (dipersist kebijakan); semua node di host itu ikut diperbarui. */
  toggle(rec: NodeRec, on: boolean): void
  /** Lepas sesi iframe milik node yang targetnya hilang. */
  forget(rec: NodeRec): void
}

/** Isi pengganti `$redirect` -> body base64 + content-type untuk `Fetch.fulfillRequest`. */
export function redirectBody(r: { body: string; contentType: string }): { body: string; contentType: string } {
  return r.contentType.endsWith(BASE64_SUFFIX)
    ? { body: r.body, contentType: r.contentType.slice(0, -BASE64_SUFFIX.length) }
    : { body: Buffer.from(r.body).toString('base64'), contentType: r.contentType }
}

/** Router Shields satu host browser; tanpa `policy` hanya batas popup yang berlaku. */
export function createShieldRouter(ops: ShieldOps): ShieldRouter {
  const { table, policy } = ops
  const now = ops.now ?? Date.now
  const frames = new Map<string, NodeRec>() // sesi iframe OOPIF -> node pemilik
  const bursts = new Map<string, number[]>()
  const owner = (sid: string | undefined) => table.session(sid) ?? (sid ? frames.get(sid) : undefined)
  const shielded = (rec: NodeRec) => !!policy && !policy.isOff(hostOnly(rec.state.url))
  const send = (cdp: CdpClient, method: string, params: object, sid: string | undefined) => {
    cdp.send(method, params, sid).catch(ignoreClosed(method, { sessionId: sid }))
  }

  const verdict = (rec: NodeRec, sid: string | undefined, p: Record<string, unknown>): AdblockVerdict => {
    const url = (p.request as { url?: unknown } | undefined)?.url
    if (!policy || typeof url !== 'string' || !shielded(rec)) return PASS
    const kind = String(p.resourceType ?? 'Other')
    if (kind === 'Document') {
      if (sid === rec.sessionId && p.frameId === rec.targetId) return PASS // dokumen utama: navigasi pengguna/agent tak pernah diblokir
      return policy.check(url, rec.state.url, 'sub_frame')
    }
    return policy.check(url, rec.state.url, kind.toLowerCase() as 'script')
  }

  const allowBurst = (nodeId: string): boolean => {
    const t = now()
    const recent = (bursts.get(nodeId) ?? []).filter((x) => t - x < POPUP_BURST_WINDOW_MS)
    const ok = recent.length < POPUP_BURST_MAX
    if (ok) recent.push(t)
    bursts.set(nodeId, recent)
    return ok
  }

  return {
    async enable(cdp, sid) {
      if (!policy) return
      await cdp.send(CDP.fetchEnable, FETCH_PATTERNS, sid)
      await cdp.send(CDP.setAutoAttach, AUTO_ATTACH, sid)
    },

    paused(cdp, p, sid) {
      const requestId = p.requestId
      const rec = owner(sid)
      const v = rec ? verdict(rec, sid, p) : PASS
      if (!v.block || !rec) { send(cdp, CDP.continueRequest, { requestId }, sid); return }
      ops.patch(rec, { blockedAds: (rec.state.blockedAds ?? 0) + 1 })
      if (!v.redirect) { send(cdp, CDP.failRequest, { requestId, errorReason: 'BlockedByClient' }, sid); return }
      const r = redirectBody(v.redirect)
      send(cdp, CDP.fulfillRequest, { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: r.contentType }], body: r.body }, sid)
    },

    attached(cdp, p, parentSid) {
      const child = typeof p.sessionId === 'string' ? p.sessionId : undefined
      if (!child) return
      const rec = owner(parentSid)
      const type = (p.targetInfo as { type?: unknown } | undefined)?.type
      if (rec && type === 'iframe' && policy) {
        frames.set(child, rec)
        send(cdp, CDP.fetchEnable, FETCH_PATTERNS, child)
        send(cdp, CDP.setAutoAttach, AUTO_ATTACH, child) // OOPIF bersarang
      }
      if (p.waitingForDebugger === true) send(cdp, CDP.runIfWaiting, {}, child)
    },

    detached(p) { if (typeof p.sessionId === 'string') frames.delete(p.sessionId) },

    popupAllowed(opener, url) {
      const nodeId = opener.nodeId
      const filtered = !!policy && shielded(opener) && policy.check(url, opener.state.url, 'main_frame').block
      if (filtered || !allowBurst(nodeId)) {
        ops.patch(opener, { blockedPopups: (opener.state.blockedPopups ?? 0) + 1 })
        log.info('shields.popup', 'popup blocked', { ids: { nodeId }, host: hostOnly(url), reason: filtered ? 'filter' : 'burst' })
        return false
      }
      return true
    },

    pageState(url) {
      return policy ? { shieldsOff: policy.isOff(hostOnly(url)), blockedAds: 0, blockedPopups: 0 } : {}
    },

    toggle(rec, on) {
      if (!policy) throw new BrowserError('bad_request', `shields toggle on node ${rec.nodeId}: ad blocking is not running`)
      const host = hostOnly(rec.state.url)
      policy.setOff(host, !on)
      for (const r of table.nodes.values()) if (hostOnly(r.state.url) === host) ops.patch(r, { shieldsOff: !on })
    },

    forget(rec) {
      for (const [sid, r] of frames) if (r === rec) frames.delete(sid)
      bursts.delete(rec.nodeId)
    },
  }
}
