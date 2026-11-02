// Wiring produksi env-settings: process.env + tabel `app` + file secret di `<dataDir>/secrets`.
// Dipisah dari service supaya service tetap murni; modul ini menyentuh db.ts (bun:sqlite).
import { join } from 'node:path'
import { dataDir } from './config'
import { openDb } from './db'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { createFileSecretStore } from './envSecrets.store'
import type { EnvSettingsApiDeps } from './envSettings.api'
import { createEnvSettings, type EnvSettings } from './envSettings.service'
import { createAppRowOverrideStore } from './envSettings.store'

const SECRETS_SUBDIR = 'secrets'

let instance: EnvSettings | undefined

/**
 * Buat (sekali) dan terapkan overlay. Panggil di boot SETELAH `writeTokenToEnv` dan SEBELUM modul
 * yang membaca env (ledger/kanal): snapshot `base` diambil di sini, sebelum overlay pertama.
 */
export function initEnvSettings(): EnvSettings {
  if (!instance) {
    // Koneksi kedua ke webterm.db: db.ts memegang koneksi pribadi, dan baris `app` ini mandiri.
    instance = createEnvSettings({
      registry: ENV_REGISTRY,
      bootstrapKeys: BOOTSTRAP_ONLY_KEYS,
      target: process.env,
      overrides: createAppRowOverrideStore(openDb()),
      secrets: createFileSecretStore(join(dataDir(), SECRETS_SUBDIR)),
    })
    instance.apply()
  }
  return instance
}

/** Dependensi rute. `root` = root token terkonfigurasi; gerbang /api sudah memverifikasinya. */
export function envSettingsApiDeps(): EnvSettingsApiDeps {
  return { service: initEnvSettings(), rootGate: () => (process.env.WEBTERM_TOKEN ?? '').trim() !== '' }
}
