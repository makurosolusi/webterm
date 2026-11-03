// Klien WS biner ke /ws/browser: SATU socket untuk semua node browser (PLAN b §4.4).
// Frame biner (header `decodeFrameHeader`) -> `onFrame`; teks JSON -> `onMsg`. Token lewat query,
// sama seperti `ws.ts`. Attach disimpan dan diputar ulang di tiap (re)connect; input yang dikirim
// saat socket mati DIBUANG (input basi yang terlambat tiba lebih berbahaya daripada hilang).
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import type { ClientMsg, ServerMsg, ViewportMsg } from '../shared/browser.contract'
import { decodeFrameHeader } from '../shared/browser.wire'
import { tokenQuery } from './api'

const RECONNECT_MS = 1000
const WS_OPEN = 1 // WebSocket.readyState OPEN (protokol)

export interface BrowserListener {
  onFrame: (seq: number, jpeg: Uint8Array) => void
  onMsg: (msg: ServerMsg) => void
  onConnection: (up: boolean) => void
}

export interface BrowserStream {
  /** Daftarkan pendengar untuk satu node (satu per id; yang baru menggantikan). Mengembalikan unsubscribe + detach. */
  subscribe: (id: string, l: BrowserListener) => () => void
  attach: (id: string, vp: ViewportMsg) => void
  resize: (id: string, vp: ViewportMsg) => void
  detach: (id: string) => void
  send: (msg: ClientMsg) => void
  /** Putus socket dan lupakan attach lama (ganti workspace); node berikutnya menyambung ulang. */
  reset: () => void
}

const isServerMsg = (v: unknown): v is ServerMsg =>
  typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string' && typeof (v as { id?: unknown }).id === 'string'

/** Bangun klien di atas pembuat socket (diinjeksi supaya test tak butuh server). */
export function createBrowserStream(open: () => WebSocket): BrowserStream {
  const listeners = new Map<string, BrowserListener>()
  const attached = new Map<string, ViewportMsg>()
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (m: ClientMsg) => {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(m))
  }

  const route = (data: unknown) => {
    if (typeof data === 'string') {
      let msg: unknown
      try {
        msg = JSON.parse(data)
      } catch {
        return // pesan server rusak: tidak ada penerima yang bisa diberi tahu; frame/pesan berikutnya tetap jalan
      }
      if (isServerMsg(msg)) listeners.get(msg.id)?.onMsg(msg)
    } else if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data)
      const h = decodeFrameHeader(bytes)
      if (h) listeners.get(h.nodeId)?.onFrame(h.seq, bytes.subarray(h.offset))
    }
  }

  const connect = () => {
    const sock = open()
    sock.binaryType = 'arraybuffer'
    ws = sock
    sock.onopen = () => {
      for (const l of listeners.values()) l.onConnection(true)
      for (const [id, vp] of attached) send({ t: 'attach', id, ...vp })
    }
    sock.onmessage = (ev) => route(ev.data)
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      for (const l of listeners.values()) l.onConnection(false)
      if (attached.size > 0 && !timer) timer = setTimeout(() => { timer = null; if (!ws) connect() }, RECONNECT_MS)
    }
    sock.onerror = () => sock.close()
  }

  const detach = (id: string) => {
    if (attached.delete(id)) send({ t: 'detach', id })
  }

  return {
    subscribe(id, l) {
      listeners.set(id, l)
      return () => {
        if (listeners.get(id) === l) listeners.delete(id)
        detach(id)
      }
    },
    attach(id, vp) {
      attached.set(id, vp)
      if (!ws) connect() // bila masih CONNECTING, onopen yang mengirim attach
      else send({ t: 'attach', id, ...vp })
    },
    resize(id, vp) {
      if (!attached.has(id)) return
      attached.set(id, vp)
      send({ t: 'resize', id, ...vp })
    },
    detach,
    send,
    reset() {
      attached.clear()
      if (timer) { clearTimeout(timer); timer = null }
      const sock = ws
      ws = null // `onclose` mengabaikan socket yang bukan `ws` aktif, jadi tak ada reconnect otomatis
      sock?.close()
    },
  }
}

let workspaceId = ''

/** Workspace yang dilayani socket bersama; server mengikat profil/cookie per workspace. Ganti = socket baru. */
export function setBrowserWorkspace(id: string): void {
  if (id === workspaceId) return
  workspaceId = id
  browserStream.reset()
}

/** Workspace yang sedang dilayani socket bersama ('' sebelum App memberi tahu). */
export const getBrowserWorkspace = (): string => workspaceId

function browserWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const q = [tokenQuery(), workspaceId === '' ? '' : `workspaceId=${encodeURIComponent(workspaceId)}`].filter(Boolean).join('&') // `new WebSocket` tak bisa set header; token ikut di query
  return `${proto}://${location.host}${BROWSER_WS_PATH}${q === '' ? '' : `?${q}`}`
}

/** Klien bersama untuk seluruh node browser di tab ini. */
export const browserStream: BrowserStream = createBrowserStream(() => new WebSocket(browserWsUrl()))
