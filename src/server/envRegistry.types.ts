// Tipe + pembangun entri registry env. Registry adalah DATA: tidak ada logika di file domain.
// Satu sumber kebenaran untuk default/validasi/kelas risiko tiap kunci yang bisa diatur dari Pengaturan.

import type { EnvKindV2, EnvSpecMeta } from '../shared/envSettings.contract'

export type EnvKind = EnvKindV2
/** Id grup bebas (domain baru tak perlu mengedit tipe ini); label/urutan lewat envRegistry.groups.ts. */
export type EnvGroup = string

export interface EnvSpec extends EnvSpecMeta {
  key: string
  group: EnvGroup
  kind: EnvKind
  label: string
  description: string
  /** Nilai bila env dan override sama-sama kosong; absen = tak ada default statis. */
  default?: string
  /** Hanya `enum`. */
  options?: readonly string[]
  /** Hanya `number`. */
  min?: number
  max?: number
  /** Hanya `secret`: bentuk yang diterima. */
  pattern?: RegExp
  /** Hanya `string`: wajib path absolut. */
  absolutePath?: boolean
  /** Perubahan baru berlaku setelah restart (default aman: true kecuali terbukti dibaca per-panggilan). */
  restartRequired: boolean
  /** Hanya boleh diubah bila request lolos gerbang root token. */
  dangerous: boolean
}

interface Meta extends EnvSpecMeta {
  label: string
  description: string
  /** Terbukti dibaca ulang tiap panggilan, jadi tak butuh restart (setara `restart: 'hot'`). */
  hot?: boolean
  dangerous?: boolean
}

function base(key: string, group: EnvGroup, kind: EnvKind, m: Meta): EnvSpec {
  const { hot, ...meta } = m
  const restart = m.restart ?? (hot ? 'hot' : 'boot')
  return { ...meta, key, group, kind, restart, restartRequired: restart === 'boot', dangerous: m.dangerous ?? false }
}

/** Flag `on|off` kanonik. */
export function flag(key: string, group: EnvGroup, m: Meta, def: 'on' | 'off' = 'off'): EnvSpec {
  return { ...base(key, group, 'flag', m), default: def }
}

/** Salah satu dari `options`. */
export function enumOf(key: string, group: EnvGroup, options: readonly string[], def: string, m: Meta): EnvSpec {
  return { ...base(key, group, 'enum', m), options, default: def }
}

/** String bebas satu baris; `def` opsional, `absolutePath` mewajibkan path absolut. */
export function text(key: string, group: EnvGroup, m: Meta, extra: { def?: string; absolutePath?: boolean } = {}): EnvSpec {
  return { ...base(key, group, 'string', m), default: extra.def, absolutePath: extra.absolutePath }
}

/** Secret write-only; `pattern` = bentuk yang diterima. */
export function secret(key: string, group: EnvGroup, pattern: RegExp, m: Meta): EnvSpec {
  return { ...base(key, group, 'secret', m), pattern }
}

/** Bilangan dalam [min, max]; `def` = nilai bila env kosong. */
export function num(key: string, group: EnvGroup, min: number, max: number, def: number, m: Meta): EnvSpec {
  return { ...base(key, group, 'number', m), min, max, default: String(def) }
}
