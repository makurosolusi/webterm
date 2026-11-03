// Kontrak node browser di canvas (PLAN/BROWSER-CANVAS-b.md §4). Sumber tunggal konstanta + tipe:
// WS lain MENGIMPOR dari sini, tidak menyalin literal. Perubahan kontrak = permintaan ke orkestrator.
// Murni deklarasi: tanpa import client/server, tanpa side effect saat import.

// ---- §4.1 Konstanta bernama ----
export const BROWSER_KIND = 'browser'
export const BROWSER_WS_PATH = '/ws/browser'
export const BROWSER_REST_PREFIX = '/api/browser'
export const BROWSER_CONTROL_PREFIX = '/api/control/browser'
export const MAX_FRAMES_IN_FLIGHT = 2
export const JPEG_QUALITY_DEFAULT = 60
export const FRAME_MAX_BUFFERED_BYTES = 1_048_576
export const RESIZE_DEBOUNCE_MS = 150
export const DSF_MAX = 2
export const ZOOM_PAUSE_BELOW = 0.25
export const LEASE_TTL_MS = 60_000
export const HUMAN_IDLE_MS = 5_000
export const SNAPSHOT_MAX_CHARS = 60_000
export const SCREENSHOT_MAX_BYTES = 2_097_152
export const COOKIE_BODY_MAX_BYTES = 1_048_576
export const COOKIE_PREVIEW_TTL_MS = 300_000
export const DEFAULT_MAX_LIVE = 3
export const DEFAULT_DISCARD_MS = 300_000
export const DEFAULT_COOKIE_TTL_DAYS = 7
export const WAIT_MAX_MS = 10_000
// Batas validasi pesan (keputusan konservatif WS-00; PLAN hanya menyebut teks <= 64 KiB).
export const TEXT_MAX_BYTES = 64 * 1024
export const ID_MAX_BYTES = 255 // = batas idLen 1 byte pada header frame
export const URL_MAX_CHARS = 8192
export const VIEWPORT_MAX = 16_384
export const TOUCH_POINTS_MAX = 10
export const FRAME_TYPE = 1

/** Bitmask modifier (§4.4): Alt=1 Ctrl=2 Meta=4 Shift=8. */
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const
export const MODS_MAX = 15

// ---- §4.2 Nama env (WS-11 yang mendaftarkan ke registry; semua default OFF/aman) ----
export const ENV_BROWSER = {
  enabled: 'WEBTERM_BROWSER',
  bin: 'WEBTERM_BROWSER_BIN',
  maxLive: 'WEBTERM_BROWSER_MAX_LIVE',
  discardMs: 'WEBTERM_BROWSER_DISCARD_MS',
  agent: 'WEBTERM_BROWSER_AGENT',
  allowHosts: 'WEBTERM_BROWSER_ALLOW_HOSTS',
  cookieImport: 'WEBTERM_BROWSER_COOKIE_IMPORT',
  cookieTtlDays: 'WEBTERM_BROWSER_COOKIE_TTL_DAYS',
} as const
/** Kunci SecretStore untuk vault cookie; dibuat acak, bukan env ketikan user. */
export const VAULT_KEY_NAME = 'WEBTERM_BROWSER_VAULT_KEY'
export const MAX_LIVE_RANGE = { min: 1, max: 8 } as const

// ---- §4.3 Tipe inti ----
export type Lease = 'human' | 'agent'
export type LiveState = 'live' | 'paused' | 'discarded'
export type BlockReason =
  | 'scheme' | 'private_host' | 'dns_fail' | 'not_allowed_port' | 'no_binary' | 'disabled' | 'max_live'
export type BrowserErrorCode =
  | 'lease_agent' | 'lease_human' | 'human_active' | 'stale_ref' | 'no_binary' | 'disabled'
  | 'blocked' | 'not_found' | 'too_large' | 'bad_request' | 'crashed'

/** Field baru `WsNode` (ditambahkan WS-11, bukan di sini). */
export interface BrowserNodeFields { url?: string; agentControl?: boolean }

export interface BrowserState {
  id: string; url: string; title: string; loading: boolean
  canBack: boolean; canForward: boolean; lease: Lease; live: LiveState; blocked?: BlockReason
}

/** Satu frame screencast; `seq` uint32 diberi host dan dikembalikan klien lewat `ack`. */
export interface Frame { seq: number; jpeg: Uint8Array }

/** Dilempar `BrowserHostApi.navigate` bila penjaga navigasi menolak; hanya hostname, tanpa URL. */
export class BlockedError extends Error {
  constructor(readonly reason: BlockReason, readonly hostname?: string) {
    super(`browser navigation blocked: ${reason}${hostname ? ` (${hostname})` : ''}`)
    this.name = 'BlockedError'
  }
}

// ---- §4.4 Pesan WS: nilai enum jadi sumber union ----
export const MOUSE_TYPES = ['down', 'up', 'move', 'wheel'] as const
export const MOUSE_BUTTONS = ['none', 'left', 'middle', 'right', 'back', 'forward'] as const // nama CDP
export const KEY_TYPES = ['down', 'up'] as const
export const TOUCH_TYPES = ['start', 'move', 'end', 'cancel'] as const
export const NAV_ACTIONS = ['go', 'back', 'forward', 'reload', 'stop'] as const
export const DIALOG_KINDS = ['alert', 'confirm', 'prompt', 'beforeunload'] as const

export interface TouchPoint { x: number; y: number; id: number; force?: number }
/** x,y = koordinat halaman (CSS px viewport) dari `toPagePoint`. */
export interface MouseInput {
  t: 'mouse'; type: (typeof MOUSE_TYPES)[number]; x: number; y: number
  button: (typeof MOUSE_BUTTONS)[number]; buttons: number; clickCount: number; mods: number
  dx: number; dy: number
}
export interface KeyInput {
  t: 'key'; type: (typeof KEY_TYPES)[number]; key: string; code: string; text: string; vk: number; mods: number
}
export interface TextInput { t: 'text'; text: string }
export interface ImeInput { t: 'ime'; text: string; start: number; end: number }
export interface TouchInput { t: 'touch'; type: (typeof TOUCH_TYPES)[number]; points: TouchPoint[] }
/** Input manusia yang diteruskan ke `BrowserHostApi.input` (tanpa `id`). Alias `InputEvent` = nama di PLAN. */
export type BrowserInputEvent = MouseInput | KeyInput | TextInput | ImeInput | TouchInput
export type { BrowserInputEvent as InputEvent }

type WithId<T> = T & { id: string }
export interface ViewportMsg { w: number; h: number; dpr: number }
export type ClientMsg =
  | WithId<{ t: 'attach' } & ViewportMsg>
  | WithId<{ t: 'resize' } & ViewportMsg>
  | { t: 'detach'; id: string }
  | { t: 'ack'; id: string; seq: number }
  | WithId<BrowserInputEvent>
  | { t: 'nav'; id: string; action: (typeof NAV_ACTIONS)[number]; url?: string }
  | { t: 'copy'; id: string }
  | { t: 'dialog'; id: string; accept: boolean; text?: string }
  | { t: 'takeover'; id: string }

export type ServerMsg =
  | ({ t: 'state' } & BrowserState)
  | { t: 'dialog'; id: string; kind: (typeof DIALOG_KINDS)[number]; message: string; defaultPrompt?: string }
  | { t: 'cursor'; id: string; css: string }
  | { t: 'copy'; id: string; text: string }
  | { t: 'error'; id: string; code: BrowserErrorCode; hostname?: string }

/** Pembaca lease untuk gateway (WS-04), diimplementasikan WS-07. */
export interface LeaseView {
  holder(nodeId: string): Lease
  /** Gateway memanggil tiap input manusia yang lolos (dasar `HUMAN_IDLE_MS`). */
  noteHumanInput(nodeId: string): void
  /** Aksi `takeover` dari UI: lease kembali ke human. */
  takeover(nodeId: string): void
}

export interface BrowserHostApi {
  open(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState>
  navigate(nodeId: string, url: string): Promise<void> // lewat navigation.guard; melempar BlockedError
  setViewport(nodeId: string, w: number, h: number, dpr: number): Promise<void>
  startScreencast(nodeId: string, onFrame: (f: Frame) => void): Promise<void>
  stopScreencast(nodeId: string): Promise<void>
  ackFrame(nodeId: string, seq: number): void
  input(nodeId: string, ev: BrowserInputEvent): Promise<void> // tidak mengecek lease; pemanggil yang cek
  cdp(nodeId: string, method: string, params?: object): Promise<unknown> // HANYA via cdpAllowlist.ts
  discard(nodeId: string): Promise<void>
  state(nodeId: string): BrowserState | undefined
  onState(cb: (s: BrowserState) => void): () => void
  isLoading(nodeId: string): boolean
}

// ---- §4.5 REST /api/browser/* (tidak ada respons yang memuat nilai cookie) ----
export type CookieFormat = 'storageState' | 'netscape'
export interface BrowserStatusResp {
  enabled: boolean; binFound: boolean; version?: string; live: number; maxLive: number
  agentEnabled: boolean; cookieImportEnabled: boolean
}
export interface CookieDomainInfo { domain: string; count: number; expiresAt?: number }
export interface CookiePreviewReq { format: CookieFormat; content: string }
export interface CookiePreviewResp {
  previewId: string; domains: Array<{ domain: string; count: number; hasSession: boolean }>; expiresAt: number
}
export interface CookieCommitReq { previewId: string; domains: string[] }
export interface CookieCommitResp { imported: number; domains: string[] }

// ---- §4.6 Kontrol agent /api/control/browser/:nodeId/:verb ----
export const BROWSER_CAPS = { read: 'browser.read', act: 'browser.act' } as const
export type BrowserCap = (typeof BROWSER_CAPS)[keyof typeof BROWSER_CAPS]
export const BROWSER_VERB_CAP = {
  status: 'browser.read', snapshot: 'browser.read', screenshot: 'browser.read', wait: 'browser.read',
  navigate: 'browser.act', click: 'browser.act', type: 'browser.act', press: 'browser.act',
  scroll: 'browser.act', handoff: 'browser.act', release: 'browser.act',
} as const satisfies Record<string, BrowserCap>
export type BrowserVerb = keyof typeof BROWSER_VERB_CAP

/** Body request per verb; `ref` berformat `e12`, `snapId` dari `snapshot` terakhir. */
export interface VerbBodies {
  status: Record<string, never>; snapshot: Record<string, never>
  screenshot: { maxWidth?: number }
  wait: { ms?: number; selectorRef?: string; loaded?: true }
  navigate: { url: string }
  click: { ref: string; snapId: string }
  type: { ref: string; snapId: string; text: string; submit?: boolean }
  press: { key: string }
  scroll: { dy: number }
  handoff: Record<string, never>; release: Record<string, never>
}
export interface VerbData {
  status: BrowserState
  snapshot: { snapId: string; content: string; truncated: boolean; url: string }
  screenshot: { mime: 'image/jpeg'; base64: string }
  wait: { ok: true }; navigate: { ok: true }; click: { ok: true }; type: { ok: true }
  press: { ok: true }; scroll: { ok: true }
  handoff: { lease: 'agent'; ttlMs: number }
  release: { lease: 'human' }
}
/** Semua respons kontrol sukses; konten halaman selalu tak tepercaya. */
export interface ControlOk<T> { ok: true; data: T; provenance: 'untrusted-web' }
