// Argumen peluncuran Chromium + jalur profil. Murni. Aturan keras (PLAN -c §6.1): TIDAK pernah
// `--no-sandbox`, profil selalu di bawah data dir webterm (bukan profil Chrome harian user).
import { join, resolve, sep } from 'node:path'

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

export interface FlagInput {
  profileDir: string
  /** Proxy penyaring SSRF, mis. `http://127.0.0.1:<port>` (wajib: tak ada jalur keluar tanpa proxy). */
  proxyServer: string
}

/** Argumen Chromium headless; CDP lewat port acak loopback (dibaca dari `DevToolsActivePort`). */
export function buildChromiumArgs(i: FlagInput): string[] {
  if (!i.proxyServer) throw new Error('browser launch: proxyServer is required (SSRF proxy)')
  if (!i.profileDir) throw new Error('browser launch: profileDir is required')
  return [
    '--headless=new',
    `--user-data-dir=${i.profileDir}`,
    `--proxy-server=${i.proxyServer}`,
    '--proxy-bypass-list=<-loopback>', // loopback ikut lewat proxy (bypass bawaan Chromium mematikan itu) [BT: spike S0]
    `--remote-debugging-address=${CDP_LOOPBACK}`,
    '--remote-debugging-port=0', // TODO(br-01): pipe (--remote-debugging-pipe) bila spike S0 membuktikan fd tambahan di Bun.spawn
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // [BT]
    '--deny-permission-prompts', // kamera/mic/geolokasi/notifikasi ditolak; ditegaskan lagi via Browser.setPermission
    // Chrome headless sendiri menelepon Google (time/update/optimization-guide) lewat proxy; tidak ada gunanya untuk
    // node browser dan itu lalu-lintas keluar tak diminta dari mesin user (terbukti di smoke Chrome nyata).
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ]
}

/** Nama izin yang ditolak host lewat `Browser.setPermission` (kamera/mic/geolokasi/notifikasi). */
export const DENIED_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'] as const
