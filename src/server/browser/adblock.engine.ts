// Mesin filter iklan/pelacak (Brave Shields-style) di atas @ghostery/adblocker (MPL-2.0): daftar prebuilt
// ads+tracking (EasyList, EasyPrivacy, uBO), diserialisasi ke data dir dan disegarkan bila lebih tua dari
// ADBLOCK_REFRESH_MS. Tak pernah menahan startup: unduhan gagal = pakai cache; tanpa cache = tanpa blokir + warn.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import type { RequestType } from '@ghostery/adblocker'
import { createLogger } from '../logs'

const log = createLogger('browser.adblock')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Umur cache mesin filter sebelum diunduh ulang (seminggu, seperti jadwal update daftar Brave/uBO). */
export const ADBLOCK_REFRESH_MS = 7 * 24 * 60 * 60 * 1000
/** Nama berkas mesin terserialisasi di dalam dir adblock. */
export const ADBLOCK_CACHE_FILE = 'adblock-engine.bin'

/** Subset `fetch` yang dipakai @ghostery/adblocker (diinjeksi di test: tanpa jaringan). */
export type AdblockFetch = (url: string) => Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>

/** Hasil cek satu request: diblokir, opsional dengan resource pengganti (aturan `$redirect` uBO). */
export type AdblockVerdict = { block: false } | { block: true; redirect?: { body: string; contentType: string } }

export interface Adblock {
  /** Putusan sinkron untuk `url` yang diminta dokumen `sourceUrl`; `type` = jenis request ala Chrome/puppeteer. */
  check(url: string, sourceUrl: string, type: RequestType): AdblockVerdict
  /** Muat cache lalu segarkan bila basi; tak pernah melempar. */
  load(): Promise<void>
  /** True bila mesin sudah ada (dari cache atau unduhan). */
  ready(): boolean
}

export interface AdblockDeps {
  dir: string
  fetch?: AdblockFetch
  now?: () => number
  refreshMs?: number
}

const PASS: AdblockVerdict = { block: false }

/** Mesin filter dengan cache berkas; mulai kosong (semua lolos) sampai `load()` selesai. */
export function createAdblock(d: AdblockDeps): Adblock {
  const file = join(d.dir, ADBLOCK_CACHE_FILE)
  const now = d.now ?? Date.now
  const refreshMs = d.refreshMs ?? ADBLOCK_REFRESH_MS
  let engine: FiltersEngine | null = null
  let loading: Promise<void> | null = null

  async function readCache(): Promise<FiltersEngine | null> {
    try {
      return FiltersEngine.deserialize(new Uint8Array(await readFile(file)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null // belum pernah diunduh: hal biasa
      log.warn('adblock.cache', 'cached filter engine is unreadable; downloading again', { error: errMsg(err) })
      return null
    }
  }

  async function save(e: FiltersEngine): Promise<void> {
    try {
      await mkdir(d.dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, e.serialize())
      await rename(tmp, file)
    } catch (err) {
      log.warn('adblock.cache', 'could not save filter engine cache; it will be downloaded again next start', { error: errMsg(err) })
    }
  }

  const cacheFresh = async (): Promise<boolean> => {
    try {
      return now() - (await stat(file)).mtimeMs < refreshMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('adblock.cache', 'cannot read filter cache age', { error: errMsg(err) })
      return false
    }
  }

  async function doLoad(): Promise<void> {
    engine ??= await readCache()
    if (engine && (await cacheFresh())) return
    try {
      const fresh = await FiltersEngine.fromPrebuiltAdsAndTracking(d.fetch ?? fetch)
      engine = fresh
      await save(fresh)
      log.info('adblock.ready', 'filter lists updated')
    } catch (err) {
      if (engine) log.warn('adblock.refresh', 'filter list refresh failed; keeping the cached lists', { error: errMsg(err) })
      else log.warn('adblock.load', 'filter lists unavailable; pages are not filtered until they download', { error: errMsg(err) })
    }
  }

  return {
    check(url, sourceUrl, type) {
      if (!engine) return PASS
      const r = engine.match(Request.fromRawDetails({ url, sourceUrl, type }))
      if (!r.match) return PASS
      return r.redirect ? { block: true, redirect: { body: r.redirect.body, contentType: r.redirect.contentType } } : { block: true }
    },
    load() {
      loading ??= doLoad().finally(() => { loading = null })
      return loading
    },
    ready: () => engine !== null,
  }
}
