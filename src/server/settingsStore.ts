// Logika settings sisi server, TANPA menyentuh SQLite — supaya bisa dites di node-env (vitest)
// sementara `db.ts` yang mengimpor `bun:sqlite` tetap Bun-only. `Db.getSettings()` /
// `Db.saveSettings()` adalah pembungkus tipis di atas fungsi di sini.
//
// SENGAJA TIDAK DIPORT dari nodeterm `src/core/settings-store.ts`:
//  - Rantai tulis atomik (`writeFileAtomic` temp+rename, mode 0600) dan `saveChain` FIFO. Keduanya
//    menjawab masalah yang tidak ada di sini: satu `INSERT … ON CONFLICT` SQLite sudah satu
//    transaksi (tak ada state setengah-tertulis), dan `bun:sqlite` sinkron — jadi siklus
//    baca→merge→tulis di `saveSettings` berjalan utuh dalam satu turn event-loop dan tidak bisa
//    diselang request lain. Yang dicegah `saveChain` nodeterm (rename terakhir vs call terakhir
//    saling tidak sepakat) secara struktural tidak bisa terjadi.
//  - 7 migrasi load-time (seed dictation, flip `openMarkdownPreview`, `terminalGpuRendering`
//    boolean→enum, `agentLaunchMode`, `newProjectStorage`, `runInBackgroundOnClose`,
//    `glassTerminals`). Semuanya membaca kunci warisan dari `settings.json` versi lama; webterm
//    belum pernah merilis settings tersimpan, jadi tidak ada satu pun file yang bisa memicunya.

import { mergeSettings, type Settings } from '../shared/settings'
import { setCustomAgentBaseResolver, type AgentId, type BuiltinAgentId } from '../shared/workspace'

/** Baca baris `app.settings`. JSON rusak / baris absen jatuh ke default, tidak melempar: settings
 *  tidak boleh menjadi alasan server gagal start. */
export function parseStored(json: string | null): Settings {
  if (!json) return mergeSettings(null)
  try {
    return mergeSettings(JSON.parse(json))
  } catch {
    return mergeSettings(null)
  }
}

/**
 * Snapshot berikutnya: `patch` di-merge di atas yang tersimpan. Satu-satunya tempat bentuk input
 * diperiksa adalah `mergeSettings` — ia sekaligus batas input HTTP (cocokkan typeof + array-ness,
 * buang kunci tak dikenal), jadi `patch` boleh berupa body mentah dari jaringan.
 */
export function nextSettings(storedJson: string | null, patch: unknown): Settings {
  return mergeSettings({ ...parseStored(storedJson), ...asRecord(patch) })
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Daftarkan lookup `custom:<uuid>` → `baseAgent` yang dibutuhkan `capabilityAgentId` di
 * `shared/workspace.ts`. Tanpa ini agent custom tidak mewarisi kapabilitas harness apa pun di sisi
 * server (resume, context link, mint session id) — lihat catatan BaseResolver di modul itu.
 *
 * `read` dipanggil tiap resolve, bukan sekali: settings bisa berubah saat runtime lewat
 * `PUT /api/settings` dan resolver harus melihat daftar terbaru.
 */
export function registerAgentBaseResolver(read: () => Settings): void {
  setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined => {
    for (const a of read().customAgents) if (a.id === id) return a.baseAgent
    return undefined
  })
}
