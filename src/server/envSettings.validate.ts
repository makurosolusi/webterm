// Validasi satu nilai env di boundary, per `kind`. Alasan = string statis (tanpa nilai input),
// jadi tak ada jalur untuk membocorkan secret lewat pesan error.
import { isAbsolute } from 'node:path'
import type { EnvSpec } from './envRegistry.types'

export const ENV_VALUE_MAX_CHARS = 512
const SECRET_MAX_CHARS = 256
// eslint-disable-next-line no-control-regex -- sengaja menolak NUL/newline/kontrol di nilai env
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export type EnvValueCheck = { ok: true; value: string } | { ok: false; reason: string }

const bad = (reason: string): EnvValueCheck => ({ ok: false, reason })

/** Periksa `raw` terhadap `spec`; nilai kembalian sudah kanonik (string di-trim, enum ke opsi kanonik). */
export function validateEnvValue(spec: EnvSpec, raw: unknown): EnvValueCheck {
  if (typeof raw !== 'string') return bad('must be a string')
  // allowEmpty: '' sah dan berarti "hapus override" (ditangani layanan); tak berlaku untuk secret/flag.
  if (spec.allowEmpty && spec.kind !== 'secret' && spec.kind !== 'flag' && raw.trim() === '') return { ok: true, value: '' }
  if (spec.kind === 'secret') {
    if (raw.length > SECRET_MAX_CHARS) return bad('too long')
    return spec.pattern?.test(raw) ? { ok: true, value: raw } : bad('has an unexpected shape')
  }
  if (spec.kind === 'flag') return raw === 'on' || raw === 'off' ? { ok: true, value: raw } : bad('must be on or off')
  if (spec.kind === 'enum') {
    const lower = raw.trim().toLowerCase()
    const hit = spec.options?.find((o) => o.toLowerCase() === lower)
    return hit === undefined ? bad('not an allowed option') : { ok: true, value: hit }
  }
  const value = raw.trim()
  if (spec.kind === 'number') {
    const n = Number(value)
    if (value === '' || !Number.isFinite(n)) return bad('must be a number')
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return bad('out of range')
    return { ok: true, value: String(n) }
  }
  if (value === '') return bad('must not be empty')
  if (value.length > ENV_VALUE_MAX_CHARS) return bad('too long')
  if (CONTROL_CHARS.test(value)) return bad('must be a single line without control characters')
  if (spec.absolutePath && !isAbsolute(value)) return bad('must be an absolute path')
  return { ok: true, value }
}
