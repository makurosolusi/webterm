// Event DOM -> pesan input `/ws/browser` (PLAN b §4.4/§4.8). Murni: tanpa DOM global, jadi bisa
// diuji dengan objek biasa. Koordinat lewat `toPagePoint` + rect berskala (zoom React Flow tak dibaca).
import { MOD, MOUSE_BUTTONS, TEXT_MAX_BYTES } from '../shared/browser.contract'
import type { KeyInput, MouseInput, TouchInput, TouchPoint } from '../shared/browser.contract'
import { toPagePoint } from '../shared/browser.coords'
import type { Rect } from '../shared/browser.coords'

export interface Viewport { w: number; h: number }
interface Mods { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export interface PointerLike extends Mods {
  clientX: number; clientY: number; button: number; buttons: number; pointerId: number; pressure: number
}
export interface WheelLike extends Mods { clientX: number; clientY: number; deltaX: number; deltaY: number; deltaMode: number; buttons: number }
export interface KeyLike extends Mods { key: string; code: string; keyCode: number; isComposing: boolean }

const LINE_PX = 16 // satu "baris" wheel DOM (deltaMode 1) dalam CSS px
const DELTA_LINE = 1
const DELTA_PAGE = 2
const IME_KEYCODE = 229 // keydown yang diklaim IME
const MOVE_INTERVAL_MS = 16 // ~satu mousemove per frame ke server
const DOUBLE_CLICK_MS = 500
const DOUBLE_CLICK_PX = 5
const TEXT_CHUNK_CHARS = TEXT_MAX_BYTES / 4 // <= 4 byte utf8 per char -> selalu muat batas pesan
const BUTTON_BY_INDEX = ['left', 'middle', 'right', 'back', 'forward'] as const satisfies readonly (typeof MOUSE_BUTTONS)[number][]

/** Bitmask modifier Alt=1 Ctrl=2 Meta=4 Shift=8. */
export const modsOf = (e: Mods): number =>
  (e.altKey ? MOD.Alt : 0) | (e.ctrlKey ? MOD.Ctrl : 0) | (e.metaKey ? MOD.Meta : 0) | (e.shiftKey ? MOD.Shift : 0)

/** Pencacah klik ganda (pointerdown tak membawa `detail`): dekat dalam waktu dan jarak -> naik, selain itu 1. */
export function makeClickCounter(now: () => number = Date.now): (x: number, y: number) => number {
  let last = { t: -Infinity, x: 0, y: 0, n: 0 }
  return (x, y) => {
    const near = now() - last.t <= DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_CLICK_PX
    last = { t: now(), x, y, n: near ? last.n + 1 : 1 }
    return last.n
  }
}

/**
 * Button for a `move`: Chromium only runs drag selection when mouseMoved names the held button (as Puppeteer does).
 * Left wins over middle; right-only stays 'none' because the right button is never forwarded (host intercept).
 */
export const heldButton = (buttons: number): 'left' | 'middle' | 'none' => (buttons & 1 ? 'left' : buttons & 4 ? 'middle' : 'none')

/** Pointer mouse -> `mouse`; null bila rect/viewport tak valid (event dibuang). */
export function mouseMsg(
  type: 'down' | 'up' | 'move', e: PointerLike, rect: Rect, vp: Viewport, clickCount = 0,
): MouseInput | null {
  const p = toPagePoint(rect, { x: e.clientX, y: e.clientY }, vp)
  if (!p) return null
  return {
    t: 'mouse', type, x: p.x, y: p.y,
    button: type === 'move' ? heldButton(e.buttons) : (BUTTON_BY_INDEX[e.button] ?? 'none'),
    buttons: e.buttons, clickCount: type === 'move' ? 0 : clickCount, mods: modsOf(e), dx: 0, dy: 0,
  }
}

/** Wheel -> `mouse` wheel; null untuk Ctrl+wheel (zoom/pinch tak diteruskan) atau rect tak valid. */
export function wheelMsg(e: WheelLike, rect: Rect, vp: Viewport): MouseInput | null {
  if (e.ctrlKey) return null
  const p = toPagePoint(rect, { x: e.clientX, y: e.clientY }, vp)
  if (!p) return null
  const unit = e.deltaMode === DELTA_LINE ? LINE_PX : e.deltaMode === DELTA_PAGE ? vp.h : 1
  return {
    t: 'mouse', type: 'wheel', x: p.x, y: p.y, button: 'none', buttons: e.buttons, clickCount: 0,
    mods: modsOf(e), dx: e.deltaX * unit, dy: e.deltaY * unit,
  }
}

/** Sentuh: perbarui peta titik aktif lalu kirim SEMUA titik aktif; null bila titik tak valid. */
export function touchMsg(
  kind: 'start' | 'move' | 'end' | 'cancel', e: PointerLike, active: Map<number, TouchPoint>, rect: Rect, vp: Viewport,
): TouchInput | null {
  if (kind === 'end' || kind === 'cancel') active.delete(e.pointerId)
  else {
    const p = toPagePoint(rect, { x: e.clientX, y: e.clientY }, vp)
    if (!p) return null
    active.set(e.pointerId, { x: p.x, y: p.y, id: e.pointerId, force: Math.min(1, Math.max(0, e.pressure)) })
  }
  return { t: 'touch', type: kind, points: [...active.values()] }
}

export type KeyKind = 'key' | 'copy' | 'paste' | 'ignore'

/** Ctrl/Cmd+C -> copy (server yang membaca seleksi); Ctrl/Cmd+V -> biarkan event paste; IME -> abaikan. */
export function classifyKey(e: KeyLike): KeyKind {
  if (e.isComposing || e.keyCode === IME_KEYCODE) return 'ignore'
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'c') return 'copy'
    if (k === 'v') return 'paste'
  }
  return 'key'
}

/** Tombol -> `key`; `text` terisi hanya untuk karakter tercetak (tanpa Ctrl/Meta) dan Enter. */
export function keyMsg(type: 'down' | 'up', e: KeyLike): KeyInput {
  const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey
  return {
    t: 'key', type, key: e.key, code: e.code, vk: e.keyCode, mods: modsOf(e),
    text: e.key === 'Enter' ? '\r' : printable ? e.key : '',
  }
}

/** Pecah teks tempel agar tiap pesan muat batas 64 KiB; tidak memotong pasangan surrogate. */
export function chunkText(text: string, max = TEXT_CHUNK_CHARS): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + max, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1 // high surrogate di ujung
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

export interface MoveCoalescer { move(m: MouseInput): void; flush(): void; dispose(): void }

/** Batasi mousemove (leading + trailing, satu per interval); `flush` mengirim move tertunda SEBELUM down/up/wheel agar urutan terjaga. */
export function makeMoveCoalescer(send: (m: MouseInput) => void, intervalMs = MOVE_INTERVAL_MS): MoveCoalescer {
  let pending: MouseInput | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    timer = undefined
    if (!pending) return
    const p = pending
    pending = null
    send(p)
    timer = setTimeout(tick, intervalMs)
  }
  return {
    move(m) {
      if (timer === undefined) { send(m); timer = setTimeout(tick, intervalMs) } else pending = m
    },
    flush() {
      if (!pending) return
      const p = pending
      pending = null
      send(p)
    },
    dispose() { clearTimeout(timer); timer = undefined; pending = null },
  }
}
