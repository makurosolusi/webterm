// Klien WS biner ke /ws/browser: SATU socket untuk semua node browser (PLAN b §4.4).
// Frame biner (header `decodeFrameHeader`) -> `onFrame`; teks JSON -> `onMsg`. Token lewat query,
// sama seperti `ws.ts`. Attach disimpan dan diputar ulang di tiap (re)connect; input yang dikirim
// saat socket mati DIBUANG (input basi yang terlambat tiba lebih berbahaya daripada hilang); node
// tahu lewat `onConnection(false)`. Reconnect: backoff full-jitter `reconnectDelay`, berhenti selama
// socket bersama `offline`/`auth` (server tak terjangkau / sesi UI habis), lanjut saat `connected`.
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import type { AudioChunk, ClientMsg, FrameLatency, ServerMsg, ViewportMsg } from '../shared/browser.contract'
import { decodeAudioFrame, decodeFrameHeader } from '../shared/browser.wire'
import { getConnection, reconnectDelay, subscribeConnection, type ConnectionPhase } from './ws.connection'

const WS_OPEN = 1 // WebSocket.readyState OPEN (protokol)

export interface BrowserListener {
  /** `lat` hanya pada frame pertama sesudah input bercap waktu (I1-d). */
  onFrame: (seq: number, jpeg: Uint8Array, lat?: FrameLatency, tabId?: string) => void
  onMsg: (msg: ServerMsg) => void
  /** One audio chunk of this node (frame type 3); only arrives after `setAudio(id, true)`. */
  onAudio?: (chunk: AudioChunk) => void
  onConnection: (up: boolean) => void
}

export interface BrowserStream {
  /** Daftarkan pendengar untuk satu node (satu per id; yang baru menggantikan). Mengembalikan unsubscribe + detach. */
  subscribe: (id: string, l: BrowserListener) => () => void
  /** `profileId` = the profile the node was created on (see `ClientMsg` attach); kept for re-attaches after a reconnect. */
  attach: (id: string, vp: ViewportMsg, profileId?: string) => void
  resize: (id: string, vp: ViewportMsg) => void
  detach: (id: string) => void
  /** Listen (on) or stop listening to the node's audio. The intent survives detach/reconnect: it is re-sent after every attach until set off. */
  setAudio: (id: string, on: boolean) => void
  send: (msg: ClientMsg) => void
  /** Putus socket dan lupakan attach lama (ganti workspace); node berikutnya menyambung ulang. */
  reset: () => void
}

/** Fase socket bersama yang membuat reconnect sia-sia: tunggu `connected`. */
const paused = (p: ConnectionPhase): boolean => p === 'offline' || p === 'auth'

const isServerMsg = (v: unknown): v is ServerMsg =>
  typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string' && typeof (v as { id?: unknown }).id === 'string'

/** Bangun klien di atas pembuat socket (diinjeksi supaya test tak butuh server). */
export function createBrowserStream(open: () => WebSocket): BrowserStream {
  const listeners = new Map<string, BrowserListener>()
  const listening = new Set<string>() // nodes whose audio the user wants; replayed after each attach (the server forgets on socket close/detach)
  const attached = new Map<string, ViewportMsg & { profileId?: string }>()
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0 // reconnect gagal berturut-turut; direset oleh open

  const send = (m: ClientMsg) => {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(m))
  }
  /** Attach, then the audio intent (the server answers `not_found` to `audio` before `attach`). */
  const sendAttach = (id: string, vp: ViewportMsg) => {
    send({ t: 'attach', id, ...vp })
    if (listening.has(id)) send({ t: 'audio', id, on: true })
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
      const a = decodeAudioFrame(bytes)
      if (a) { listeners.get(a.nodeId)?.onAudio?.(a); return }
      const h = decodeFrameHeader(bytes)
      if (h) listeners.get(h.nodeId)?.onFrame(h.seq, bytes.subarray(h.offset), h.lat, h.tabId)
    }
  }

  const connect = () => {
    const sock = open()
    sock.binaryType = 'arraybuffer'
    ws = sock
    sock.onopen = () => {
      attempt = 0
      for (const l of listeners.values()) l.onConnection(true)
      for (const [id, vp] of attached) sendAttach(id, vp)
    }
    sock.onmessage = (ev) => route(ev.data)
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      for (const l of listeners.values()) l.onConnection(false)
      schedule()
    }
    sock.onerror = () => sock.close()
  }

  const schedule = () => {
    if (attached.size === 0 || timer || ws || paused(getConnection().phase)) return
    timer = setTimeout(() => { timer = null; if (!ws) connect() }, reconnectDelay(attempt++))
  }

  // Socket bersama memutuskan kapan server terjangkau: jeda saat offline/auth, sambung saat kembali.
  subscribeConnection((c) => {
    if (paused(c.phase) && timer) { clearTimeout(timer); timer = null }
    if (c.phase === 'connected' && !ws && attached.size > 0) {
      if (timer) { clearTimeout(timer); timer = null }
      connect()
    }
  })

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
    attach(id, vp, profileId) {
      const msg = { ...vp, ...(profileId ? { profileId } : {}) }
      attached.set(id, msg)
      if (!ws) connect() // bila masih CONNECTING, onopen yang mengirim attach
      else sendAttach(id, msg)
    },
    resize(id, vp) {
      const prev = attached.get(id)
      if (!prev) return
      attached.set(id, { ...vp, ...(prev.profileId ? { profileId: prev.profileId } : {}) })
      send({ t: 'resize', id, ...vp })
    },
    detach,
    setAudio(id, on) {
      if (on) listening.add(id); else listening.delete(id)
      if (attached.has(id)) send({ t: 'audio', id, on })
    },
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
  const q = workspaceId === '' ? '' : `workspaceId=${encodeURIComponent(workspaceId)}` // no credential in the URL: the same-origin upgrade carries the session cookie
  return `${proto}://${location.host}${BROWSER_WS_PATH}${q === '' ? '' : `?${q}`}`
}

/** Klien bersama untuk seluruh node browser di tab ini. */
export const browserStream: BrowserStream = createBrowserStream(() => new WebSocket(browserWsUrl()))
