// Gateway WS biner /ws/browser (§4.4): satu socket per klien, banyak node. Handler murni `handleBrowserConnection`;
// pemasangan ke `upgrade` (origin+token root, node-token ditolak) adalah tugas WS-11. Galat = {t:'error'}, socket tetap hidup.
import { BlockedError, DSF_MAX, TEXT_MAX_BYTES } from '../../shared/browser.contract'
import type { BrowserErrorCode, ClientMsg, LeaseView } from '../../shared/browser.contract'
import { parseClientMsg } from '../../shared/browser.wire'
import type { RawData, WebSocket } from 'ws'
import { createLogger } from '../logs'
import { createSerialQueue } from './browserWs.backpressure'
import type { SerialQueue } from './browserWs.backpressure'
import type { GatewayHost, Viewer, ViewerHub, ViewerSink } from './browserWs.viewers'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.ws')
/** Kode penutupan WS untuk fitur mati (policy violation). */
const CLOSE_DISABLED = 1008
/** Selaras batas mentah `parseClientMsg` (JSON-escape bisa membengkakkan teks); lebih besar tak perlu di-decode. */
const RAW_MAX_BYTES = TEXT_MAX_BYTES * 8

export interface GatewayDeps {
  host: GatewayHost
  leases: LeaseView
  /** Hub bersama semua koneksi (`createViewerHub`). */
  hub: ViewerHub
  /** Flag fitur; dibaca tiap koneksi dan tiap pesan (off = socket ditutup). */
  enabled(): boolean
  /** Workspace pemilik socket ini (profil Chromium); dari upgrade (WS-11). */
  workspaceId: string
  /** URL tersimpan node (`WsNode.url`) untuk memulihkan node yang discarded; opsional. */
  initialUrl?(nodeId: string): string | undefined
}

const INPUT_TYPES = new Set<ClientMsg['t']>(['mouse', 'key', 'text', 'ime', 'touch', 'nav'])
/** Input manusia murni (tanpa `nav`): dikirim fire-and-forget oleh host, tak perlu antre di belakang input lain. */
const DIRECT_INPUT = new Set<ClientMsg['t']>(['mouse', 'key', 'text', 'ime', 'touch'])
const errorCode = (e: unknown): { code: BrowserErrorCode; hostname?: string } =>
  e instanceof BlockedError ? { code: 'blocked', hostname: e.hostname }
    : e instanceof BrowserError ? { code: e.code, hostname: e.hostname }
      : { code: 'crashed' } // galat tak dikenal: jangan bocorkan pesan internal ke klien

const rawBytes = (d: RawData): Buffer => (Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d))
const rawSize = (d: RawData): number => (Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d.byteLength)

function makeSink(ws: WebSocket): ViewerSink {
  const onSent = (err?: Error) => { if (err) log.warn('browser.ws', 'send failed', { error: err.name }) }
  return {
    get bufferedAmount() { return ws.bufferedAmount },
    sendBinary(bytes, done) {
      if (ws.readyState !== ws.OPEN) return false
      ws.send(bytes, { binary: true }, (err) => { onSent(err); done?.() })
      return true
    },
    sendJson(msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg), onSent) },
  }
}

/** Layani satu socket klien sampai ia putus; semua listener & penonton dilepas saat `close`/`error`. */
export function handleBrowserConnection(ws: WebSocket, deps: GatewayDeps): void {
  const { host, leases, hub } = deps
  const sink = makeSink(ws)
  const viewer: Viewer = { sink }
  const attached = new Set<string>()
  const queues = new Map<string, SerialQueue>()
  let closed = false

  const fail = (id: string, err: unknown) => {
    const { code, hostname } = errorCode(err)
    if (code === 'crashed' && !(err instanceof BrowserError)) log.error('browser.ws', 'unexpected gateway failure', { ids: { nodeId: id }, error: err instanceof Error ? err.name : typeof err })
    sink.sendJson({ t: 'error', id, code, hostname })
  }
  const reject = (id: string, code: BrowserErrorCode) => sink.sendJson({ t: 'error', id, code })

  const cleanup = () => {
    if (closed) return
    closed = true
    for (const id of attached) {
      hub.leave(id, viewer).catch((err) => log.warn('browser.ws', 'detach on close failed', { ids: { nodeId: id }, error: err instanceof Error ? err.name : typeof err }))
    }
    attached.clear()
    queues.clear()
  }

  async function run(m: ClientMsg): Promise<void> {
    const id = m.id
    if (closed) return
    switch (m.t) {
      case 'attach': {
        await host.open(id, deps.workspaceId, deps.initialUrl?.(id))
        await host.setViewport(id, m.w, m.h, Math.min(m.dpr, DSF_MAX))
        if (closed) return
        hub.join(id, viewer)
        const s = hub.stateMsg(id)
        if (s) sink.sendJson(s)
        await hub.sync(id)
        return
      }
      case 'detach':
        attached.delete(id)
        await hub.leave(id, viewer)
        return
      case 'resize':
        await host.setViewport(id, m.w, m.h, Math.min(m.dpr, DSF_MAX))
        return
      case 'takeover':
        leases.takeover(id)
        hub.refreshState(id)
        return
      case 'copy':
        sink.sendJson({ t: 'copy', id, text: await host.selectionText(id) })
        return
      case 'dialog':
        await host.answerDialog(id, m.accept, m.text)
        return
      case 'nav':
        await host.navAction(id, m.action, m.url)
        return
      case 'shields':
        await host.setShields(id, m.on)
        return
      case 'ack':
        return
      default: // mouse | key | text | ime | touch
        await host.input(id, m)
    }
  }

  function dispatch(m: ClientMsg): void {
    if (m.t === 'ack') { hub.ack(m.id, viewer, m.seq); return } // sinkron: ack tak boleh menunggu antrean input
    if (m.t === 'attach') attached.add(m.id) // pesan berikutnya antre di belakang attach (urutan serial per node)
    else if (!attached.has(m.id)) { reject(m.id, 'not_found'); return }
    if (INPUT_TYPES.has(m.t) && leases.holder(m.id) === 'agent') { reject(m.id, 'lease_agent'); return }
    if (INPUT_TYPES.has(m.t)) leases.noteHumanInput(m.id)
    const task = async () => {
      try { await run(m) } catch (err) { if (!closed) fail(m.id, err) }
    }
    let q = queues.get(m.id)
    if (!q) queues.set(m.id, (q = createSerialQueue()))
    // Antrean idle = tak ada attach/resize/nav/copy tertunda: input langsung ke host (yang tak menunggu balasan
    // Chromium; DevTools InputModel.ts:72,89). Urutan tetap terjaga oleh satu socket CDP. Antrean sibuk = antre,
    // supaya input tak pernah mendahului attach yang belum selesai.
    if (DIRECT_INPUT.has(m.t) && q.depth === 0) { void task(); return }
    q.push(task, m.t === 'mouse' && m.type === 'move')
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return
    if (!deps.enabled()) { reject('', 'disabled'); ws.close(CLOSE_DISABLED, 'disabled'); return }
    const m = isBinary || rawSize(data) > RAW_MAX_BYTES ? null : parseClientMsg(rawBytes(data).toString('utf8'))
    if (!m) { reject('', 'bad_request'); return }
    dispatch(m)
  })
  ws.on('close', cleanup)
  ws.on('error', (err) => {
    log.warn('browser.ws', 'socket error', { error: err.name })
    cleanup()
  })
  if (!deps.enabled()) {
    reject('', 'disabled')
    ws.close(CLOSE_DISABLED, 'disabled')
  }
}
