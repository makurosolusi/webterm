// Kawat /ws/browser (§4.4): header frame biner + parser pesan klien yang ketat. Murni, tanpa side effect.
import {
  ID_MAX_BYTES, FRAME_TYPE, FRAME_TYPE_TIMED, KEY_TYPES, MODS_MAX, MOUSE_BUTTONS, MOUSE_TYPES,
  NAV_ACTIONS, TEXT_MAX_BYTES, TOUCH_POINTS_MAX, TOUCH_TYPES, URL_MAX_CHARS, VIEWPORT_MAX,
} from './browser.contract'
import type { ClientMsg, FrameLatency, TouchPoint } from './browser.contract'
import { parseConsoleMsg } from './browser.console'

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
const HEADER_FIXED = 2 // type + idLen
const SEQ_BYTES = 4
const UINT32_MAX = 0xffff_ffff
const LAT_BYTES = 20 // ls f64 + tiga f32 (ms; presisi f32 lebih dari cukup untuk durasi)

/**
 * Bangun frame server->klien: `[type][idLen][id utf8][seq u32 BE][lat?][jpeg]`; `lat` hanya pada FRAME_TYPE_TIMED.
 * Melempar bila id > 255 byte / seq bukan uint32.
 */
export function encodeFrame(nodeId: string, seq: number, jpeg: Uint8Array, lat?: FrameLatency): Uint8Array {
  const id = enc.encode(nodeId)
  if (id.length > ID_MAX_BYTES) throw new Error(`encodeFrame: nodeId ${id.length} bytes exceeds ${ID_MAX_BYTES}`)
  if (!Number.isInteger(seq) || seq < 0 || seq > UINT32_MAX) throw new Error(`encodeFrame: seq ${seq} is not a uint32`)
  const at = HEADER_FIXED + id.length + SEQ_BYTES
  const latLen = lat ? LAT_BYTES : 0
  const out = new Uint8Array(at + latLen + jpeg.length)
  out[0] = lat ? FRAME_TYPE_TIMED : FRAME_TYPE
  out[1] = id.length
  out.set(id, HEADER_FIXED)
  const dv = new DataView(out.buffer)
  dv.setUint32(at - SEQ_BYTES, seq, false)
  if (lat) {
    dv.setFloat64(at, lat.ls, false)
    dv.setFloat32(at + 8, lat.rxToDispatch, false)
    dv.setFloat32(at + 12, lat.dispatchToSwap, false)
    dv.setFloat32(at + 16, lat.swapToServer, false)
  }
  out.set(jpeg, at + latLen)
  return out
}

/** Baca header frame; `offset` = awal JPEG. null bila bukan frame / terpotong / id bukan utf8. */
export function decodeFrameHeader(buf: Uint8Array): { nodeId: string; seq: number; offset: number; lat?: FrameLatency } | null {
  const timed = buf[0] === FRAME_TYPE_TIMED
  if (buf.length < HEADER_FIXED || (buf[0] !== FRAME_TYPE && !timed)) return null
  const idEnd = HEADER_FIXED + buf[1]
  const offset = idEnd + SEQ_BYTES + (timed ? LAT_BYTES : 0)
  if (buf.length < offset) return null
  let nodeId: string
  try {
    nodeId = dec.decode(buf.subarray(HEADER_FIXED, idEnd))
  } catch {
    return null // id bukan utf8 valid = frame rusak; pemanggil membuang frame
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const seq = dv.getUint32(idEnd, false)
  if (!timed) return { nodeId, seq, offset }
  const at = idEnd + SEQ_BYTES
  const lat = { ls: dv.getFloat64(at, false), rxToDispatch: dv.getFloat32(at + 8, false), dispatchToSwap: dv.getFloat32(at + 12, false), swapToServer: dv.getFloat32(at + 16, false) }
  return { nodeId, seq, offset, lat }
}

// ---- parseClientMsg: validasi ketat, null untuk apa pun yang janggal ----
type Obj = Record<string, unknown>
const RAW_MAX_CHARS = TEXT_MAX_BYTES * 8 // JSON-escape bisa 6x ukuran teks
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown, min: number, max: number): v is number => fin(v) && Number.isInteger(v) && v >= min && v <= max
const bytesOk = (s: string, max: number) => s.length <= max && (s.length * 3 <= max || enc.encode(s).length <= max)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && bytesOk(v, max)
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => set.includes(v as T)
const dim = (v: unknown): v is number => fin(v) && v > 0 && v <= VIEWPORT_MAX
const KEY_FIELD_MAX = 64
const DPR_MAX_INPUT = 16 // clamp ke DSF_MAX dilakukan host; di sini hanya tolak nilai absurd

function viewport(m: Obj) {
  return dim(m.w) && dim(m.h) && fin(m.dpr) && m.dpr > 0 && m.dpr <= DPR_MAX_INPUT ? { w: m.w, h: m.h, dpr: m.dpr } : null
}

function points(v: unknown): TouchPoint[] | null {
  if (!Array.isArray(v) || v.length > TOUCH_POINTS_MAX) return null
  const out: TouchPoint[] = []
  for (const p of v) {
    if (!isObj(p) || !fin(p.x) || !fin(p.y) || !int(p.id, 0, UINT32_MAX)) return null
    if (p.force !== undefined && !(fin(p.force) && p.force >= 0 && p.force <= 1)) return null
    out.push(p.force === undefined ? { x: p.x, y: p.y, id: p.id } : { x: p.x, y: p.y, id: p.id, force: p.force })
  }
  return out
}

function parseInput(t: string, id: string, m: Obj): ClientMsg | null {
  switch (t) {
    case 'mouse': {
      const num0 = (v: unknown) => (v === undefined ? 0 : fin(v) ? v : null) // dx/dy opsional
      const dx = num0(m.dx), dy = num0(m.dy)
      const button = m.button === undefined ? 'none' : m.button
      const buttons = m.buttons === undefined ? 0 : m.buttons
      const clickCount = m.clickCount === undefined ? 0 : m.clickCount
      const mods = m.mods === undefined ? 0 : m.mods
      if (!oneOf(m.type, MOUSE_TYPES) || !fin(m.x) || !fin(m.y) || dx === null || dy === null) return null
      if (!oneOf(button, MOUSE_BUTTONS) || !int(buttons, 0, 31) || !int(clickCount, 0, 10) || !int(mods, 0, MODS_MAX)) return null
      return { t: 'mouse', id, type: m.type, x: m.x, y: m.y, button, buttons, clickCount, mods, dx, dy }
    }
    case 'key': {
      const text = m.text === undefined ? '' : m.text
      const vk = m.vk === undefined ? 0 : m.vk
      const mods = m.mods === undefined ? 0 : m.mods
      if (!oneOf(m.type, KEY_TYPES) || !str(m.key, KEY_FIELD_MAX) || !str(m.code, KEY_FIELD_MAX)) return null
      if (!str(text, KEY_FIELD_MAX) || !int(vk, 0, 0xffff) || !int(mods, 0, MODS_MAX)) return null
      return { t: 'key', id, type: m.type, key: m.key, code: m.code, text, vk, mods }
    }
    case 'text':
      return str(m.text, TEXT_MAX_BYTES) ? { t: 'text', id, text: m.text } : null
    case 'ime':
      return str(m.text, TEXT_MAX_BYTES) && int(m.start, 0, TEXT_MAX_BYTES) && int(m.end, 0, TEXT_MAX_BYTES)
        ? { t: 'ime', id, text: m.text, start: m.start, end: m.end } : null
    case 'touch': {
      const pts = points(m.points)
      return oneOf(m.type, TOUCH_TYPES) && pts ? { t: 'touch', id, type: m.type, points: pts } : null
    }
    default:
      return null
  }
}

/** Parse pesan teks klien (string JSON atau objek hasil parse) jadi `ClientMsg`; null = tolak (`bad_request`). */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  let m = raw
  if (typeof raw === 'string') {
    if (raw.length > RAW_MAX_CHARS) return null
    try {
      m = JSON.parse(raw)
    } catch {
      return null // JSON rusak = pesan jelek; gateway membalas bad_request tanpa mengecho isinya
    }
  }
  if (!isObj(m) || typeof m.t !== 'string' || !str(m.id, ID_MAX_BYTES) || m.id === '') return null
  const id = m.id
  switch (m.t) {
    case 'attach': case 'resize': {
      const v = viewport(m)
      return v ? { t: m.t, id, ...v } : null
    }
    case 'detach': case 'copy': case 'takeover':
      return { t: m.t, id }
    case 'ack':
      return int(m.seq, 0, UINT32_MAX) ? { t: 'ack', id, seq: m.seq } : null
    case 'nav': {
      if (!oneOf(m.action, NAV_ACTIONS)) return null
      if (m.url === undefined) return m.action === 'go' ? null : { t: 'nav', id, action: m.action }
      return str(m.url, URL_MAX_CHARS) ? { t: 'nav', id, action: m.action, url: m.url } : null
    }
    case 'shields':
      return typeof m.on === 'boolean' ? { t: 'shields', id, on: m.on } : null
    case 'console':
      return parseConsoleMsg(m, id)
    case 'dialog':
      if (typeof m.accept !== 'boolean') return null
      if (m.text === undefined) return { t: 'dialog', id, accept: m.accept }
      return str(m.text, TEXT_MAX_BYTES) ? { t: 'dialog', id, accept: m.accept, text: m.text } : null
    default: {
      const ev = parseInput(m.t, id, m)
      if (!ev || m.ls === undefined) return ev
      return fin(m.ls) && m.ls >= 0 ? { ...ev, ls: m.ls } as ClientMsg : null // cap waktu latensi klien (I1-d)
    }
  }
}
