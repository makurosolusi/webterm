// Registry env gabungan + kunci bootstrap. Satu pintu untuk lookup; data ada di envRegistry.*.ts.
import { CA2_ENV_SPECS } from './envRegistry.ca2'
import { CENTRAL_ENV_SPECS } from './envRegistry.central'
import { CHANNEL_ENV_SPECS } from './envRegistry.channels'
import { PLATFORM_ENV_SPECS } from './envRegistry.platform'
import type { EnvSpec } from './envRegistry.types'

export const ENV_REGISTRY: readonly EnvSpec[] = [...CHANNEL_ENV_SPECS, ...CENTRAL_ENV_SPECS, ...CA2_ENV_SPECS, ...PLATFORM_ENV_SPECS]

/** Kunci kunci-global: HANYA dari env proses, tak pernah dari Pengaturan (lihat BOOTSTRAP_ONLY_KEYS). */
export const ENV_SETTINGS_SWITCH = 'WEBTERM_ENV_SETTINGS'

/**
 * Hanya lewat env. Kalau API bisa mengubahnya, shell agent di mesin yang sama bisa mematikan
 * pengamannya sendiri (approval/mint/hook auth), mengalihkan token bot ke host lain (API_BASE),
 * atau memindahkan DB/token. Tampil read-only sebagai info (terisi/kosong saja, tanpa nilai).
 */
export const BOOTSTRAP_ONLY_KEYS: readonly string[] = [
  'HOST',
  'PORT',
  'WEBTERM_HOST',
  'WEBTERM_DATA_DIR',
  'WEBTERM_TOKEN',
  'WEBTERM_ALLOW_LOOPBACK_APPROVAL',
  'WEBTERM_ALLOW_TOKEN_MINT',
  'WEBTERM_STRICT_HOOK_AUTH',
  'WEBTERM_TELEGRAM_API_BASE',
  ENV_SETTINGS_SWITCH,
]

const BY_KEY = new Map(ENV_REGISTRY.map((s) => [s.key, s]))
const BOOTSTRAP = new Set(BOOTSTRAP_ONLY_KEYS)

/** Spesifikasi kunci yang bisa diatur, atau undefined. */
export function specFor(key: string): EnvSpec | undefined {
  return BY_KEY.get(key)
}

/** Apakah kunci ini hanya boleh lewat env. */
export function isBootstrapOnly(key: string): boolean {
  return BOOTSTRAP.has(key)
}
