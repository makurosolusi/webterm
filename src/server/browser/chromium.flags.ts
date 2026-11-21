// Argumen peluncuran Chromium + jalur profil. Murni. Aturan keras (PLAN -c §6.1): TIDAK pernah
// `--no-sandbox`, profil selalu di bawah data dir webterm (bukan profil Chrome harian user).
import { resolve, sep } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { flagOn } from '../envFlag'

export const PROFILES_SUBDIR = ['browser', 'profiles'] as const
/** Pola ID workspace yang aman jadi nama direktori (tanpa separator/traversal). */
export const SAFE_WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/
export const CDP_LOOPBACK = '127.0.0.1'

/** Direktori profil `<dataRoot>/browser/profiles/<workspaceId>`; melempar bila ID tak aman atau keluar dari root. */
export function profileDirFor(dataRoot: string, workspaceId: string): string {
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) throw new Error('browser profile: workspaceId has unsafe characters or length')
  const base = resolve(dataRoot, ...PROFILES_SUBDIR)
  const dir = resolve(base, workspaceId)
  if (!dir.startsWith(base + sep)) throw new Error('browser profile: resolved path escapes the data dir')
  return dir
}

/** Viewport awal tab (juga ukuran jendela offscreen), sama dengan Orca `BrowserWindow({width:1280,height:800})`. */
export const DEFAULT_VIEWPORT = { w: 1280, h: 800, dpr: 1 } as const
/** Jauh di luar layar mana pun: jendela headful ada (UA/fingerprint normal) tapi tak terlihat. */
const OFFSCREEN_XY = -32_000
export const OFFSCREEN_POS = `${OFFSCREEN_XY},${OFFSCREEN_XY}`

export type HeadlessReason = 'env' | 'no_display'

/**
 * Alasan jatuh ke headless, atau null = headful offscreen (default). Headless hanya bila diminta
 * (`WEBTERM_BROWSER_HEADLESS=on`) atau Linux tanpa display (tanpa DISPLAY/WAYLAND_DISPLAY Chrome headful tak bisa start).
 */
export function headlessReason(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): HeadlessReason | null {
  if (flagOn(env[ENV_BROWSER.headless])) return 'env'
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'no_display'
  return null
}

export interface FlagInput {
  profileDir: string
  /** Proxy penyaring SSRF, mis. `http://127.0.0.1:<port>` (wajib: tak ada jalur keluar tanpa proxy). */
  proxyServer: string
  /** Fallback `--headless=new` (lihat `headlessReason`); default headful offscreen. */
  headless?: boolean
  platform?: NodeJS.Platform
}

/**
 * Argumen Chromium headful dengan jendela di luar layar, di-screencast lewat CDP (port acak loopback,
 * dibaca dari `DevToolsActivePort`). Meniru Orca offscreen browser backend (MIT, stablyai/orca:
 * `BrowserWindow({show:false,width:1280,height:800})` + `setBackgroundThrottling(false)` + screencast debugger):
 * headless mengirim UA `HeadlessChrome` dan debug port membuat `navigator.webdriver=true`, keduanya langsung
 * dicap bot (Google /sorry/). UA TIDAK dioverride: `--user-agent`/`setUserAgentOverride` mengosongkan Client Hints.
 */
export function buildChromiumArgs(i: FlagInput): string[] {
  if (!i.proxyServer) throw new Error('browser launch: proxyServer is required (SSRF proxy)')
  if (!i.profileDir) throw new Error('browser launch: profileDir is required')
  const display = i.headless
    ? ['--headless=new']
    : [`--window-position=${OFFSCREEN_POS}`, `--window-size=${DEFAULT_VIEWPORT.w},${DEFAULT_VIEWPORT.h}`]
  return [
    ...display,
    '--disable-blink-features=AutomationControlled', // navigator.webdriver=false walau CDP lewat debug port
    // Padanan setBackgroundThrottling(false) Orca: jendela offscreen/tertutup tetap render & timer jalan.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--user-data-dir=${i.profileDir}`,
    `--proxy-server=${i.proxyServer}`,
    '--proxy-bypass-list=<-loopback>', // loopback ikut lewat proxy (bypass bawaan Chromium mematikan itu) [BT: spike S0]
    `--remote-debugging-address=${CDP_LOOPBACK}`,
    '--remote-debugging-port=0', // TODO(br-01): pipe (--remote-debugging-pipe) bila spike S0 membuktikan fd tambahan di Bun.spawn
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // [BT]
    '--deny-permission-prompts', // kamera/mic/geolokasi/notifikasi ditolak; ditegaskan lagi via Browser.setPermission
    // Chrome sendiri menelepon Google (time/update/optimization-guide) lewat proxy; tidak ada gunanya untuk
    // node browser dan itu lalu-lintas keluar tak diminta dari mesin user (terbukti di smoke Chrome nyata).
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio', // sound reaches the client through the in-page capture (browser-audio.md), never the server's speakers; no autoplay flag: a forwarded click is a real gesture
    // macOS menjepit jendela "offscreen" kembali ke layar dan jendela awal mencuri fokus (diukur, Chrome 156):
    // tanpa jendela awal; tiap node membuka jendelanya sendiri di latar (windowPlacement). OS lain tetap memakai
    // tab awal: tanpa jendela, Chrome di Linux/Windows bisa keluar saat jendela node terakhir ditutup.
    (i.platform ?? process.platform) === 'darwin' ? '--no-startup-window' : 'about:blank',
  ]
}

/**
 * Param `Target.createTarget` jendela node: satu jendela per node, dibuat di latar tanpa fokus (padanan Orca:
 * satu `BrowserWindow({show:false})` per halaman). macOS tak mengizinkan jendela di luar layar (dijepit, sisa ~40px
 * terlihat) -> minimized; screencast, input, rAF tetap jalan (diukur ~56 fps). OS lain: koordinat di luar layar.
 */
export function windowPlacement(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const bounds = platform === 'darwin'
    ? { windowState: 'minimized' }
    : { left: OFFSCREEN_XY, top: OFFSCREEN_XY, width: DEFAULT_VIEWPORT.w, height: DEFAULT_VIEWPORT.h }
  return { newWindow: true, background: true, focus: false, ...bounds }
}

/** Nama izin yang ditolak host lewat `Browser.setPermission` (kamera/mic/geolokasi/notifikasi). */
export const DENIED_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'] as const
