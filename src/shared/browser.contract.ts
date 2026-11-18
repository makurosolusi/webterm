// Kontrak node browser di canvas (PLAN/BROWSER-CANVAS-b.md §4). Sumber tunggal konstanta + tipe:
// WS lain MENGIMPOR dari sini, tidak menyalin literal. Perubahan kontrak = permintaan ke orkestrator.
// Murni deklarasi: tanpa import client/server, tanpa side effect saat import.
import type { ConsoleClientMsg, ConsoleLevel, ConsoleServerMsg } from './browser.console'
import type { AgentTabView } from './browser.agentTabs'
import type { DeviceChoice } from './browser.devices'
import type { BrowserTabEvent, BrowserTabsState } from './browser.tabs'
import type { BrowserChallenge } from './browser.challenge'
import type { DownloadItem } from './browser.downloads'
import type { DownloadsBody, DownloadsReply } from './browser.contract.downloads'
import type { LayoutData, TabsData } from './browser.contract.layout'

// ---- §4.1 Konstanta bernama ----
export const BROWSER_KIND = 'browser'
export const BROWSER_WS_PATH = '/ws/browser'
export const BROWSER_REST_PREFIX = '/api/browser'
export const BROWSER_CONTROL_PREFIX = '/api/control/browser'
/**
 * Frame terkirim ke SATU klien yang belum di-ack klien itu. Hanya mengatur laju kirim ke klien tersebut: host
 * meng-ack Chromium saat frame diterima, dan frame berikutnya menunggu sebagai satu frame tertunda (terbaru menang).
 */
export const MAX_FRAMES_IN_FLIGHT = 2
/** Kualitas JPEG screencast (DevTools ScreencastView.ts memakai 80). */
export const JPEG_QUALITY_DEFAULT = 80
/** Batas sisi frame screencast dalam piksel perangkat (DevTools ScreencastView.ts:560 `maxImageDimension`). */
export const SCREENCAST_MAX_DIM = 2048
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
/** Frame yang membawa `FrameLatency` (I1-d) sesudah seq; klien lama cukup mengabaikannya. */
export const FRAME_TYPE_TIMED = 2
/** Input tanpa frame dalam rentang ini dianggap tak mengubah layar: sampel dibuang, bukan dicatat sebagai outlier. */
export const INPUT_LATENCY_STALE_MS = 1000

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
  headless: 'WEBTERM_BROWSER_HEADLESS',
  captureLinks: 'WEBTERM_BROWSER_CAPTURE_LINKS',
  downloadsAuto: 'WEBTERM_BROWSER_DOWNLOADS_AUTO',
} as const
/** Kunci SecretStore untuk vault cookie; dibuat acak, bukan env ketikan user. */
export const VAULT_KEY_NAME = 'WEBTERM_BROWSER_VAULT_KEY'
export const MAX_LIVE_RANGE = { min: 1, max: 12 } as const

// ---- §4.3 Tipe inti ----
export type Lease = 'human' | 'agent'
export type LiveState = 'live' | 'paused' | 'discarded'
export type BlockReason =
  | 'scheme' | 'private_host' | 'dns_fail' | 'not_allowed_port' | 'no_binary' | 'disabled' | 'max_live'
export type BrowserErrorCode =
  | 'lease_agent' | 'human_active' | 'stale_ref' | 'no_binary' | 'disabled'
  | 'blocked' | 'not_found' | 'too_large' | 'bad_request' | 'crashed' | 'launch_failed' | 'max_live' | 'human_verification_required'

/** Why Chromium could not start (server log + `error.reason` on the wire); never carries a path or a pid. */
export const LAUNCH_REASONS = ['profile_locked', 'bin_not_found', 'spawn_error', 'debug_port_timeout', 'crashed_on_start', 'sandbox_unavailable', 'connect_failed'] as const
export type LaunchReason = (typeof LAUNCH_REASONS)[number]

/** Field baru `WsNode` (ditambahkan WS-11, bukan di sini). */
export interface BrowserNodeFields { url?: string; agentControl?: boolean }

export interface BrowserState {
  id: string; url: string; title: string; loading: boolean
  canBack: boolean; canForward: boolean; lease: Lease; live: LiveState; blocked?: BlockReason
  /** Shields (ad/tracker blocking): undefined = no blocker on the server; counts reset on each page load. */
  shieldsOff?: boolean; blockedAds?: number; blockedPopups?: number
  /** Chromium net error name of the last failed main-frame navigation (e.g. "net::ERR_NAME_NOT_RESOLVED"); cleared on the next page that loads. */
  netError?: string
  /** The page is an "are you human?" check (Google /sorry, captcha, Cloudflare): agents are paused until the user continues. */
  challenge?: BrowserChallenge
}

/**
 * Latensi input->frame (ms, jam server = jam Chromium, satu mesin) untuk frame PERTAMA yang `metadata.timestamp`
 * (CDP `Page.ScreencastFrameMetadata`: "frame swap timestamp", detik epoch) jatuh sesudah dispatch input. `ls` =
 * cap waktu kirim milik klien, dipantulkan apa adanya supaya klien mengukur total di jamnya sendiri.
 */
export interface FrameLatency { ls: number; rxToDispatch: number; dispatchToSwap: number; swapToServer: number }
/** Satu frame screencast; `seq` uint32 diberi host dan dikembalikan klien lewat `ack`. */
export interface Frame { seq: number; jpeg: Uint8Array; lat?: FrameLatency; /** Tab the frame shows; absent = the node's focused (view) tab. */ tabId?: string }

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
/** Input manusia yang diteruskan ke `BrowserHostApi.input` (tanpa `id`). Alias `InputEvent` = nama di PLAN.
 * `ls` opsional = cap waktu kirim klien (epoch ms) untuk pengukur latensi; host memantulkannya di `Frame.lat`. */
export type BrowserInputEvent = (MouseInput | KeyInput | TextInput | ImeInput | TouchInput) & { ls?: number; /** Tab (pane) the input is for; absent = the focused tab. */ tab?: string }
export type { BrowserInputEvent as InputEvent }

type WithId<T> = T & { id: string }
export interface ViewportMsg { w: number; h: number; dpr: number }
export type ClientMsg =
  /** `profileId` = the profile the node was created on: the board may not be saved yet, so the server cannot read it there. */
  | WithId<{ t: 'attach'; profileId?: string } & ViewportMsg>
  /** `tab` = size of that tab's pane (split view); absent = the whole node area. */
  | WithId<{ t: 'resize'; tab?: string } & ViewportMsg>
  | { t: 'detach'; id: string }
  | { t: 'ack'; id: string; seq: number }
  | WithId<BrowserInputEvent>
  /** Tabs on screen (one per pane) and the focused one: only these stream, the others stop (split view). */
  | { t: 'view'; id: string; visible: string[]; focus?: string }
  | { t: 'nav'; id: string; action: (typeof NAV_ACTIONS)[number]; url?: string }
  | { t: 'copy'; id: string }
  | { t: 'dialog'; id: string; accept: boolean; text?: string }
  | { t: 'takeover'; id: string }
  /** "I'm done": the user finished the human check; the node stops showing it and agents may continue. */
  | { t: 'challengeDone'; id: string }
  | { t: 'shields'; id: string; on: boolean }
  | { t: 'device'; id: string; device: DeviceChoice | null } // device mode (browser.devices.ts); null = Responsive
  | ConsoleClientMsg

export type ServerMsg =
  | ({ t: 'state' } & BrowserState)
  | { t: 'dialog'; id: string; kind: (typeof DIALOG_KINDS)[number]; message: string; defaultPrompt?: string }
  | { t: 'cursor'; id: string; css: string }
  | { t: 'copy'; id: string; text: string }
  | { t: 'error'; id: string; code: BrowserErrorCode; hostname?: string; /** Specific cause of a `launch_failed`. */ reason?: LaunchReason }
  /** Legacy: popups are tabs now (`tab` events); the server no longer sends this and the UI integration removes the handler. */
  | { t: 'popup'; id: string; url: string }
  /** Whole tab list of the node (sent on attach). */
  | { t: 'tabs'; id: string; state: BrowserTabsState }
  /** One change of the node's tab list; fold with `applyTabEvent`. */
  | { t: 'tab'; id: string; event: BrowserTabEvent }
  /** Human-readable reason an action on the tabs was refused or redirected (e.g. "Tab limit (8) reached"). */
  | { t: 'tabNotice'; id: string; message: string }
  /** Sync mode of the node (session state: sent on attach and on every change). */
  | { t: 'sync'; id: string; on: boolean }
  /** Sync could not repeat an action in pane `tab` (no element with that role and name there): show "no match" on that pane only. */
  | { t: 'syncMiss'; id: string; tab: string; reason: 'no_match' | 'cross_origin' | 'error' }
  /** One download of the node changed (begun, progress, ended); fold with `reduceDownloads`-style replace by id. */
  | { t: 'download'; id: string; item: DownloadItem }
  /** The node's whole download list (sent on attach, and after an entry was removed). */
  | { t: 'downloads'; id: string; items: DownloadItem[] }
  | ConsoleServerMsg

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
export interface BrowserStatusResp {
  enabled: boolean; binFound: boolean; version?: string; live: number; maxLive: number
  agentEnabled: boolean; cookieImportEnabled: boolean
}
export type * from './browser.contract.cookies'

// ---- §4.6 Kontrol agent /api/control/browser/:nodeId/:verb ----
export const BROWSER_CAPS = { read: 'browser.read', act: 'browser.act' } as const
export type BrowserCap = (typeof BROWSER_CAPS)[keyof typeof BROWSER_CAPS]
export const BROWSER_VERB_CAP = {
  status: 'browser.read', snapshot: 'browser.read', screenshot: 'browser.read', wait: 'browser.read', console: 'browser.read',
  open: 'browser.act', navigate: 'browser.act', click: 'browser.act', type: 'browser.act', press: 'browser.act',
  scroll: 'browser.act', handoff: 'browser.act', release: 'browser.act',
  // Tabs of one node: `tabs` lists, `tab` creates / switches / closes (`new` takes a URL, so it is an act).
  tabs: 'browser.read', tab: 'browser.act',
  // Files the node's pages downloaded: list, `read` (text) and `copy` (into the caller's working directory).
  downloads: 'browser.read',
  // Split layout of one node: `layout` reads it, `arrange` sets it, `sync` switches sync mode; reload/back/forward are page verbs.
  layout: 'browser.read', arrange: 'browser.act', sync: 'browser.act', reload: 'browser.act', back: 'browser.act', forward: 'browser.act',
} as const satisfies Record<string, BrowserCap>
export type BrowserVerb = keyof typeof BROWSER_VERB_CAP
/** CLI-only read verb (`webterm browser profiles`): lists the profile names this board can use. Not a page verb, so not in `BROWSER_VERB_CAP`; locked presets never get it. */
export const BROWSER_PROFILES_VERB = 'profiles'

/** Every page verb (not open/handoff/release/tabs/tab) may carry `tab`: act in that tab of the node, which also becomes the agent's working tab. */
export interface TabArg { tab?: string }
/**
 * `all: true` runs the verb on every tab the layout shows (the one visible tab without a split) and answers with `AllData`.
 * `click`/`type` then name the element by meaning (`name` = accessible name, optional `role`, `nth` among equals), never by ref.
 */
export interface AllArg { all?: true; name?: string; role?: string; nth?: number }
/** Body request per verb; `ref` berformat `e12`, `snapId` dari `snapshot` terakhir. */
export interface VerbBodies {
  status: TabArg; snapshot: TabArg & AllArg
  screenshot: { maxWidth?: number; /** Alias of `all`: every visible tab as a named list. */ layout?: true } & TabArg & AllArg
  wait: { ms?: number; selectorRef?: string; loaded?: true } & TabArg
  console: { limit?: number; level?: ConsoleLevel } & TabArg
  /** Only on the node-token path: a new browser node beside the caller, cabled to it; `url` = navigate it at once. */
  open: { url?: string }
  navigate: { url: string } & TabArg & AllArg
  click: { ref?: string; snapId?: string } & TabArg & AllArg
  type: { ref?: string; snapId?: string; text: string; submit?: boolean } & TabArg & AllArg
  press: { key: string } & TabArg
  scroll: { dy: number } & TabArg & AllArg
  reload: TabArg & AllArg; back: TabArg & AllArg; forward: TabArg & AllArg
  layout: Record<string, never>
  /** Shapes: see `parseLayoutSpec` (browser.layoutSpec.ts). */
  arrange: { spec: string }
  sync: { on: boolean }
  tabs: Record<string, never>
  downloads: DownloadsBody
  /** `new` = optional url; `switch` and `close` need `tab`. */
  tab: { action: 'new' | 'switch' | 'close'; url?: string; tab?: string }
  handoff: Record<string, never>; release: Record<string, never>
}
export interface VerbData {
  status: BrowserState
  snapshot: { snapId: string; content: string; truncated: boolean; url: string; tab?: string }
  screenshot: { mime: 'image/jpeg'; base64: string }
  open: { nodeId: string; url: string; note: string }
  /** Node-token `navigate` with no cabled browser opens one first and also returns the `open` fields. */
  navigate: { ok: true; /** A download this action started: its id (see the `downloads` verb). */ download?: string } & Partial<VerbData['open']>
  wait: { ok: true }; click: { ok: true; newTab?: string; note?: string; download?: string }; type: { ok: true; download?: string }
  console: { content: string; count: number; dropped: number; note?: string }
  press: { ok: true; download?: string }; scroll: { ok: true }
  reload: { ok: true }; back: { ok: true }; forward: { ok: true }
  layout: LayoutData
  arrange: LayoutData & { note: string }
  sync: { on: boolean; note: string }
  tabs: TabsData
  downloads: DownloadsReply
  tab: TabsData & { tab?: AgentTabView; note: string }
  handoff: { lease: 'agent'; ttlMs: number }
  release: { lease: 'human' }
}
export type * from './browser.contract.downloads'
export type * from './browser.contract.layout'
/** Semua respons kontrol sukses; konten halaman selalu tak tepercaya. */
export interface ControlOk<T> { ok: true; data: T; provenance: 'untrusted-web' }
