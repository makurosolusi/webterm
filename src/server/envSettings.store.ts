// Override env non-secret: SATU baris JSON di tabel `app` yang sudah ada (kunci `env_overrides`),
// pola yang sama dengan `settings`/`active` di db.ts. Tanpa migrasi: tabelnya dibuat `openDb` dan
// baris baru hanya muncul pada PUT pertama. Secret TIDAK pernah lewat sini (lihat envSecrets.store.ts).
import type { EnvSpec } from './envRegistry.types'
import { validateEnvValue } from './envSettings.validate'

export const ENV_OVERRIDES_ROW = 'env_overrides'

/** Bagian `bun:sqlite`/`node:sqlite` yang dipakai; sempit supaya store bisa dites di node-env. */
export interface AppRowDb {
  query(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
}

export interface OverrideStore {
  load(): string | null
  save(json: string): void
}

/** Store di atas tabel `app`. */
export function createAppRowOverrideStore(d: AppRowDb): OverrideStore {
  return {
    load() {
      const row = d.query('SELECT value FROM app WHERE key = ?').get(ENV_OVERRIDES_ROW) as { value: string } | null
      return row ? row.value : null
    },
    save(json) {
      d.query('INSERT INTO app (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(ENV_OVERRIDES_ROW, json)
    },
  }
}

/**
 * Baca JSON tersimpan jadi `{KEY: nilai}`. Rusak / kunci tak dikenal / secret / nilai tak valid
 * diabaikan dengan `warn` (hanya NAMA kunci), tak pernah melempar: setelan tak boleh menjatuhkan boot.
 */
export function parseOverrides(
  json: string | null,
  specOf: (key: string) => EnvSpec | undefined,
  warn: (msg: string) => void
): Record<string, string> {
  if (!json) return {}
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch {
    warn('env settings: stored overrides are unreadable JSON; ignoring all')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn('env settings: stored overrides have an unexpected shape; ignoring all')
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(parsed)) {
    const spec = specOf(key)
    const check = spec && spec.kind !== 'secret' ? validateEnvValue(spec, raw) : undefined
    if (check?.ok) out[key] = check.value
    else warn(`env settings: ignoring invalid stored override for ${spec ? key : 'an unknown key'}`)
  }
  return out
}
