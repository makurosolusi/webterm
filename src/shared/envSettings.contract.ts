// Kontrak lintas-WS Settings > Environment v2: bentuk state API + dua fungsi murni (client-safe).
// Server membangun `EnvStateV2` (envSettings.state.ts); klien hanya me-render-nya.

export type EnvAudience = 'user' | 'advanced'
/** none = langsung, hot = berlaku pada pemakaian berikutnya, boot = perlu restart server. */
export type EnvRestart = 'none' | 'hot' | 'boot'
export type EnvKindV2 = 'flag' | 'string' | 'number' | 'enum' | 'secret'
export type EnvSourceV2 = 'override' | 'env' | 'default'
export type EnvStage = 'experimental' | 'preview' | 'stable'

/** Prasyarat lunak: `key` harus bernilai salah satu `oneOf` (kosong/absen = flag on). */
export interface EnvRequire { key: string; oneOf?: string[]; note?: string }
export interface EnvGroupMeta { id: string; label: string; order: number; owner: string }

/** Field metadata v2 pada spec registry; semuanya opsional (diturunkan bila kosong). */
export interface EnvSpecMeta {
  owner?: string
  section?: string
  audience?: EnvAudience
  requires?: EnvRequire[]
  restart?: EnvRestart
  effectiveDefault?: string
  stage?: EnvStage
  since?: string
  /** Nama lama kunci ini; override tersimpan dengan nama lama dipetakan ke kunci ini. */
  aliases?: string[]
  dangerNote?: string
  optionLabels?: Record<string, string>
  unit?: string
  /** Label tampilan saat nilai kosong (mis. "<dataDir>/memory"). */
  unsetLabel?: string
  /** Nilai kosong sah dan berarti "hapus override". */
  allowEmpty?: boolean
}

export interface EnvEntryV2 extends EnvSpecMeta {
  key: string
  kind: EnvKindV2
  group: string
  label: string
  description: string
  /** Nilai tersimpan yang sudah dinormalisasi (flag on|off, enum kanonik); '' untuk secret. */
  value: string
  source: EnvSourceV2
  /** Hanya ada (true) bila override aktif sementara env proses awal berisi nilai lain; tanpa nilai. */
  envShadowed?: boolean
  default?: string
  options?: string[]
  min?: number
  max?: number
  absolutePath?: boolean
  /** Kompat v1: sama dengan `restart === 'boot'`. */
  restartRequired: boolean
  pendingRestart: boolean
  dangerous: boolean
  editable: boolean
  owner: string
  section: string
  audience: EnvAudience
  requires: EnvRequire[]
  restart: EnvRestart
  /** Nilai yang benar-benar dipakai server sekarang (kunci `boot`: nilai saat boot). */
  effective: string
  valid: boolean
  invalidReason?: string
  /** Nilai mentah yang tak sah, dipotong 40; tak pernah untuk secret. */
  rawValue?: string
  /** Hanya secret: terisi atau tidak (kompat v1 `set`), tanpa nilai. */
  set?: boolean
  secretSet?: boolean
}

export interface EnvStateV2 {
  locked: boolean
  server: { tokenSet: boolean; settingsLocked: boolean }
  groups: EnvGroupMeta[]
  entries: EnvEntryV2[]
}

/** Cermin klien-aman dari server `flagOn`: trim + lowercase === 'on'. */
export const flagIsOn = (raw: string | undefined): boolean => (raw ?? '').trim().toLowerCase() === 'on'

/** Where a behaviour key without its own card or notice is edited (Settings › Developer); server row `ui` and client filter share it. */
export const CONTROL_WHERE = 'Settings › Developer'
