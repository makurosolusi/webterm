// Hidup-mati runtime browser lewat kemampuan `browser` (ENVSIMPLE ES-08): start/stop idempoten dan aman
// dipanggil berulang dari reconcile, tanpa restart proses. Tidak ada nilai cookie/token yang dilog di sini.
import { createLogger } from '../logs'
import { onCapabilityChange } from '../featureCapabilities.runtime'
import { startBrowserRuntime } from './browser.runtime'
import type { RuntimeDeps } from './browser.runtime'
import { activeBrowser, setActiveBrowser } from './browser.state'
import { detectChromium } from './chromium.launch'

export { activeBrowser }

const log = createLogger('browser.activate')
/** Batas tunggu operasi yang sedang berjalan (start/shutdown) saat stop; lewat ini stop lanjut tanpa menunggu. */
export const BROWSER_STOP_TIMEOUT_MS = 5_000

// Serialisasi start/stop: panggilan bersamaan menumpang pada operasi yang berjalan, bukan membuat instans kedua.
let starting: Promise<void> | null = null
let stopping: Promise<void> | null = null

const withTimeout = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref()
    void p.then(() => { clearTimeout(t); resolve() }, (e) => {
      clearTimeout(t)
      log.warn('browser.stop', 'Browser operation failed while waiting', { error: e instanceof Error ? e.name : typeof e })
      resolve()
    })
  })

/** Nyalakan runtime browser bila belum hidup; tanpa Chromium = tidak melempar dan `activeBrowser()` tetap null. */
export function startBrowser(deps: RuntimeDeps): Promise<void> {
  if (stopping) return stopping.then(() => startBrowser(deps)) // stop yang berjalan selesai dulu, baru nyalakan
  if (activeBrowser()) return Promise.resolve()
  if (starting) return starting
  const p: Promise<void> = (async () => {
    try {
      if (!deps.launcher && !detectChromium(deps.env, deps.exists)) {
        log.warn('browser.start', 'Chromium not found; browser stays off')
        return
      }
      const rt = await startBrowserRuntime(deps)
      if (!rt) return
      setActiveBrowser(rt)
      log.info('browser.start', 'Browser nodes on', { maxLive: rt.status().maxLive })
    } catch (e) {
      log.error('browser.start', 'Browser failed to start', { error: e instanceof Error ? e.name : typeof e })
    }
  })().finally(() => { if (starting === p) starting = null }) // dibersihkan setelah ditetapkan, bukan di dalam IIFE
  starting = p
  return p
}

/** Matikan runtime browser (tutup halaman, lalu runtime); aman dipanggil tanpa start atau berulang. */
export function stopBrowser(): Promise<void> {
  if (stopping) return stopping
  const p: Promise<void> = (async () => {
    if (starting) await withTimeout(starting, BROWSER_STOP_TIMEOUT_MS)
    const rt = activeBrowser()
    if (!rt) return
    setActiveBrowser(null) // rute berhenti melayani sebelum penutupan selesai
    await withTimeout(rt.shutdown(), BROWSER_STOP_TIMEOUT_MS)
    log.info('browser.stop', 'Browser nodes off')
  })().finally(() => { if (stopping === p) stopping = null })
  stopping = p
  return p
}

// Browser di canvas: hook kemampuan `browser` menyalakan/mematikan runtime tanpa restart; /ws/browser dan
// /api/browser selalu terdaftar dan membaca `activeBrowser()` per panggilan. Opsi sesi PTY dihitung ulang
// tiap perubahan (hook kedua jalan setelah hook runtime). Agent terminal memakai token node-nya sendiri; node
// browser target dicari per panggilan dari edge kabel di workspace (`workspaces`), jadi tanpa capability/restart sesi.
// Shim + skill agent dipasang sekali per proses saat runtime start (`onAgentUse`); sub `browserAgent` off cukup ditolak handler.
/** Pasang hook kemampuan `browser`; mengembalikan pembatal daftar. */
export function registerBrowserCapability(deps: RuntimeDeps): () => void {
  return onCapabilityChange('browser', { start: () => startBrowser(deps), stop: () => stopBrowser() })
}
