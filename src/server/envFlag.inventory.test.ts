import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Inventori parser flag/mode LAIN di src/server (selain envFlag.ts). Tes gagal bila ada pembaca
// baru di luar daftar: parser baru harus lewat envFlag.ts (D5), atau didaftarkan di sini dengan alasan.
const SERVER_DIR = __dirname

/** Pola pembaca env yang membandingkan nilai mentah secara literal (bukan lewat parseFlag/flagOn). */
const ENV_LITERAL_COMPARE = /(?:env\.|env\[)[^\n]*?(?:===|!==)\s*'(?:1|on|true|off|0|false)'/
const LOWERCASE_LITERAL = /toLowerCase\(\)\s*(?:===|!==)\s*'(?:1|on|true|off|0|false)'/
/** Baris yang sudah lewat dialek kanonik bukan parser lain. */
const CANONICAL = /parseFlag\(|flagOn\(|flagOr\(/

/** Tiga kunci keamanan: sengaja persis `=== '1'` (strictFlag). */
const SECURITY_STRICT = ['agentStatusAuth.ts', 'approvalAuth.ts', 'control/mount.ts']
/** Beda dialek, ditunda (KE-3): `X=1` dulu senyap off; menyatukan mengubah perilaku. Lihat laporan ES-01. */
const KE3_DIALECT = ['envSettings.service.ts']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return name.endsWith('.ts') && !name.includes('.test.') && name !== 'envFlag.ts' ? [full] : []
  })
}

function offenders(): string[] {
  return sourceFiles(SERVER_DIR)
    .filter((f) => readFileSync(f, 'utf8').split('\n').some((l) => !CANONICAL.test(l) && (ENV_LITERAL_COMPARE.test(l) || LOWERCASE_LITERAL.test(l))))
    .map((f) => relative(SERVER_DIR, f))
    .sort()
}

describe('inventori parser flag di luar envFlag.ts', () => {
  it('sama dengan daftar tetap (parser baru wajib lewat envFlag.ts)', () => {
    expect(offenders()).toEqual([...SECURITY_STRICT, ...KE3_DIALECT].sort())
  })
  it('daftar tetap tidak berisi duplikat', () => {
    const all = [...SECURITY_STRICT, ...KE3_DIALECT]
    expect(new Set(all).size).toBe(all.length)
  })
})
