// Tipe + pembangun entri registry env. Registry adalah DATA: tidak ada logika di file domain.
// Satu sumber kebenaran untuk default/validasi/kelas risiko tiap kunci yang bisa diatur dari Pengaturan.

export type EnvKind = 'flag' | 'string' | 'number' | 'enum' | 'secret'
export type EnvGroup = 'ledger' | 'telegram' | 'channels' | 'central' | 'orchestrator' | 'memory' | 'control' | 'bootstrap'

export interface EnvSpec {
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

interface Meta {
  label: string
  description: string
  /** Terbukti dibaca ulang tiap panggilan, jadi tak butuh restart. */
  hot?: boolean
  dangerous?: boolean
}

function base(key: string, group: EnvGroup, kind: EnvKind, m: Meta): EnvSpec {
  return { key, group, kind, label: m.label, description: m.description, restartRequired: !m.hot, dangerous: m.dangerous ?? false }
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
