// Wiring produksi env-settings: process.env + tabel `app` + file secret di `<dataDir>/secrets`.
// Dipisah dari service supaya service tetap murni; modul ini menyentuh db.ts (bun:sqlite).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config'
import type { Database } from 'bun:sqlite'
import { openDb } from './db'
import { getDotenvBoot } from './dotenvFiles'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { createFileSecretStore } from './envSecrets.store'
import { recordAudit } from './featureCapabilities.audit'
import { settingsGuard } from './featureCapabilities.guard'
import type { EnvSettingsApiDeps } from './envSettings.api'
import { createEnvSettings, type EnvSettings } from './envSettings.service'
import { createAppRowOverrideStore } from './envSettings.store'
import { createLogger } from './logs'

const SECRETS_SUBDIR = 'secrets'

const log = createLogger('settings')

let instance: EnvSettings | undefined
let auditDb: Database | undefined
let dotenvWarned = false

/** Warn SEKALI per proses bila `.env` ada dan memasok kunci registry; hanya NAMA kunci (nilai bisa secret). */
export function warnDotenvDetected(svc: Pick<EnvSettings, 'state'>, cwd: string = getDotenvBoot().cwd): void {
  if (dotenvWarned || !existsSync(join(cwd, '.env'))) return
  const keys = svc.state({ root: false }).entries.filter((e) => e.source === 'env').map((e) => e.key)
  if (keys.length === 0) return
  dotenvWarned = true
  log.warn('env.dotenv_detected', '.env supplies registry keys; Settings overrides win over it', { count: keys.length, keys })
}

/**
 * Buat (sekali) dan terapkan overlay. Panggil di boot SETELAH `writeTokenToEnv` dan SEBELUM modul
 * yang membaca env (ledger/kanal): snapshot `base` diambil di sini, sebelum overlay pertama.
 */
export function initEnvSettings(): EnvSettings {
  if (!instance) {
    // Koneksi kedua ke webterm.db: db.ts memegang koneksi pribadi, dan baris `app` ini mandiri.
    auditDb = openDb()
    instance = createEnvSettings({
      registry: ENV_REGISTRY,
      bootstrapKeys: BOOTSTRAP_ONLY_KEYS,
      target: process.env,
      overrides: createAppRowOverrideStore(auditDb),
      secrets: createFileSecretStore(join(dataDir(), SECRETS_SUBDIR)),
    })
    instance.apply()
    warnDotenvDetected(instance)
  }
  return instance
}

/** Dependensi rute: layanan + penjaga mutasi + audit (koneksi yang sama dengan store override). */
export function envSettingsApiDeps(): EnvSettingsApiDeps {
  const service = initEnvSettings()
  return { service, guard: (req) => settingsGuard(req), audit: (entry) => { if (auditDb) recordAudit(auditDb, entry) } }
}
