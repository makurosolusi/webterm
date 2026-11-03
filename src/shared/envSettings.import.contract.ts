// Kontrak impor `.env` -> Settings (POST /api/settings/env/import). Client-safe, TANPA nilai:
// respons hanya memuat NAMA kunci + keputusan, karena `.env` bisa berisi secret.

/** add = akan ditulis sebagai override; same = override sudah sama; conflict = override beda (TIDAK ditimpa); skip = lihat alasan. */
export type ImportAction = 'add' | 'same' | 'conflict' | 'skip'
/** bootstrap = hanya lewat env; invalid = nilai gagal validasi; needs_root = kunci dangerous tanpa root token; locked = Settings terkunci. */
export type ImportSkipReason = 'bootstrap' | 'invalid' | 'needs_root' | 'locked'

export interface ImportItem {
  key: string
  action: ImportAction
  dangerous: boolean
  secret: boolean
  reason?: ImportSkipReason
}

/** Default dry-run; `apply: true` menulis semua item `add` sekaligus. Body tidak membawa path. */
export interface EnvImportRequest { apply?: boolean }

export interface EnvImportResult {
  found: boolean
  /** Jumlah kunci `.env` di luar registry (namanya tidak dibocorkan). */
  ignored: number
  items: ImportItem[]
  applied?: number
  restartRequired?: string[]
}
