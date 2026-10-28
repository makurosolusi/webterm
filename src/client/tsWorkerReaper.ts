/**
 * Matikan worker TypeScript / JavaScript Monaco begitu tidak ada lagi model berbahasa itu.
 *
 * KEBOCORANNYA NYATA DI 0.57.0 — diverifikasi langsung di `node_modules/monaco-editor`:
 * `esm/vs/languages/features/{css,html,json}/workerManager.js` punya `STOP_WHEN_IDLE_FOR = 2 menit`
 * plus `setInterval(_checkIfIdle, 30s)`, sedangkan `.../typescript/workerManager.js` TIDAK punya
 * jalur idle apa pun: ia hanya `_stopWorker()` saat `_defaults.onDidChange` menyala atau saat
 * dispose, dan worker-nya dibuat dengan `keepIdleModels: true`. Jadi file .ts/.js PERTAMA yang
 * dibuka menyalakan isolate worker yang memegang compiler TypeScript + lib.d.ts selama sisa sesi,
 * dan karena TypeScript & JavaScript punya WorkerManager TERPISAH, dua-duanya bisa tertahan
 * sekaligus. Membuang model lewat `model.dispose()` tidak melepasnya.
 *
 * Cara mematikan yang didukung: `setCompilerOptions(getCompilerOptions())` — no-op yang menyalakan
 * `_onDidChange` (diverifikasi di `register.js:152`) → `WorkerManager._stopWorker()`. Permintaan
 * berikutnya menyalakan worker baru dengan opsi & extraLibs yang sama, karena keduanya hidup di
 * objek defaults, bukan di worker.
 *
 * Keputusannya DIJAGA bebas-Monaco supaya bisa dites di node: `lazyMonaco.tsx` menyuntikkan daftar
 * model sungguhan dan stop sungguhan, test menyuntikkan palsu plus fake timer.
 */

/** Bahasa yang worker-nya tidak pernah idle sendiri. Masing-masing punya WorkerManager sendiri. */
export const TS_WORKER_LANGUAGES = ['typescript', 'javascript'] as const
export type TsWorkerLanguage = (typeof TS_WORKER_LANGUAGES)[number]

/**
 * Tenggang setelah model TS/JS terakhir pergi sebelum worker dimatikan. Disamakan dengan
 * `STOP_WHEN_IDLE_FOR` Monaco sendiri (2 menit) untuk worker css/html/json, supaya menutup satu
 * .ts lalu membuka .ts lain memakai worker yang masih hangat alih-alih mengompilasi lib.d.ts
 * ulang. Setiap event model me-arm ulang timernya, jadi ini satu timer, bukan N.
 */
export const TS_WORKER_STOP_GRACE_MS = 2 * 60 * 1000

export interface TsWorkerReaperDeps {
  /** Language id SEMUA model yang hidup (Monaco: `editor.getModels().map(m => m.getLanguageId())`). */
  liveLanguageIds(): readonly string[]
  /** Matikan worker bahasa itu (Monaco: kick `setCompilerOptions` yang no-op). */
  stopWorker(language: TsWorkerLanguage): void
  graceMs?: number
}

export interface TsWorkerReaper {
  /** Sebuah model berbahasa `language` dibuat, atau berubah MENJADI `language`. */
  modelEntered(language: string): void
  /** Sebuah model berbahasa `language` sedang dibuang, atau berubah MENINGGALKAN `language`. */
  modelLeft(language: string): void
  /** Batalkan pemeriksaan yang tertunda (teardown / test). */
  dispose(): void
}

function isTsWorkerLanguage(language: string): language is TsWorkerLanguage {
  return (TS_WORKER_LANGUAGES as readonly string[]).includes(language)
}

export function createTsWorkerReaper(deps: TsWorkerReaperDeps): TsWorkerReaper {
  const graceMs = deps.graceMs ?? TS_WORKER_STOP_GRACE_MS
  // Bahasa yang sudah punya model sejak worker-nya terakhir dimatikan. Hanya ini yang di-kick:
  // no-op setCompilerOptions pada bahasa yang belum pernah menyalakan worker memang tidak
  // berbahaya, tapi ia memaksa satu putaran diagnostics atas semua model — kerja sia-sia.
  const armed = new Set<TsWorkerLanguage>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const check = (): void => {
    timer = null
    // Baca ulang kebenarannya SEKARANG, bukan menyimpan counter: `onWillDisposeModel` menyala
    // SEBELUM model lepas dari `getModels()`, jadi hitungan yang diambil saat event selalu lebih
    // satu — dan file yang dibuka ulang dalam masa tenggang otomatis muncul di sini sebagai model
    // yang hidup.
    const live = new Set(deps.liveLanguageIds())
    for (const language of [...armed]) {
      if (live.has(language)) continue
      armed.delete(language)
      deps.stopWorker(language)
    }
  }

  return {
    modelEntered(language) {
      if (isTsWorkerLanguage(language)) armed.add(language)
    },
    modelLeft(language) {
      if (!isTsWorkerLanguage(language) || !armed.has(language)) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(check, graceMs)
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
  }
}
