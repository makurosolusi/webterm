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

/** Resolver kunci -> spec: nama kanonik atau salah satu `aliases` (nama lama) sebuah spec. */
export function specResolver(registry: readonly EnvSpec[]): (key: string) => EnvSpec | undefined {
  const byName = new Map<string, EnvSpec>()
  for (const s of registry) for (const a of s.aliases ?? []) byName.set(a, s)
  for (const s of registry) byName.set(s.key, s)
  return (key) => byName.get(key)
}

export interface ParsedOverrides {
  /** `{KEY kanonik: nilai kanonik}` yang berlaku. */
  values: Record<string, string>
  /** Kunci tak dikenal: tidak diterapkan, tapi ditulis balik apa adanya agar tak hilang saat bergantian build. */
  unknownKept: Record<string, unknown>
}

const nameForLog = (key: string): string => key.slice(0, 64)

/**
 * Baca JSON tersimpan. Rusak -> kosong (warn); alias dipetakan ke kunci kanonik (kunci kanonik menang
 * bila keduanya ada); kunci tak dikenal dipertahankan di `unknownKept`; secret / nilai tak valid / ''
 * dibuang dengan `warn` (hanya NAMA kunci). Tak pernah melempar: setelan tak boleh menjatuhkan boot.
 */
export function parseOverrides(
  json: string | null,
  resolve: (key: string) => EnvSpec | undefined,
  warn: (msg: string) => void
): ParsedOverrides {
  const out: ParsedOverrides = { values: {}, unknownKept: {} }
  if (!json) return out
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch {
    warn('env settings: stored overrides are unreadable JSON; ignoring all')
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn('env settings: stored overrides have an unexpected shape; ignoring all')
    return out
  }
  const stored = Object.entries(parsed)
  const canonical = new Set(stored.filter(([k]) => resolve(k)?.key === k).map(([k]) => k))
  for (const [key, raw] of stored) {
    const spec = resolve(key)
    if (!spec) {
      out.unknownKept[key] = raw
      warn(`env settings: keeping unknown stored override ${nameForLog(key)} (not applied)`)
      continue
    }
    if (spec.key !== key) {
      if (canonical.has(spec.key)) { warn(`env settings: ignoring legacy name ${nameForLog(key)}; ${spec.key} is also stored`); continue }
      warn(`env settings: stored override uses legacy name ${nameForLog(key)}; mapped to ${spec.key}`)
    }
    const check = spec.kind === 'secret' ? undefined : validateEnvValue(spec, raw)
    if (check?.ok && check.value !== '') out.values[spec.key] = check.value
    else warn(`env settings: ignoring invalid stored override for ${spec.key}`)
  }
  return out
}
