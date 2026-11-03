import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS } from '../shared/featureCapabilities'

// Pagar M2/S-E3: kunci katalog hanya boleh dibaca lewat isEnabled (featureCapabilities.runtime).
const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const KEYS = [...CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey), ...DERIVED_FLAGS.map((d) => d.key)]
const EXEMPT = /(^|\/)(featureCapabilities\.|envRegistry)[^/]*$|\.test\.tsx?$/

const sources = (): string[] =>
  (readdirSync(SERVER_DIR, { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f.endsWith('.ts') && !EXEMPT.test(f))

/** Kunci katalog yang diakses sebagai literal bernama (`'KEY'`) atau `env.KEY` di sumber. */
const touched = (src: string): string[] =>
  KEYS.filter((k) => new RegExp(`['"\`]${k}['"\`]|\\benv\\.${k}\\b`).test(src))

describe('pagar grep kunci katalog', () => {
  it('pemindai menemukan berkas dan mengenali pola akses', () => {
    expect(sources().length).toBeGreaterThan(50)
    expect(touched("if (flagOn(env['WEBTERM_CENTRAL'])) {}")).toEqual(['WEBTERM_CENTRAL'])
    expect(touched('process.env.WEBTERM_BROWSER')).toEqual(['WEBTERM_BROWSER'])
    expect(touched('WEBTERM_CENTRAL_X, WEBTERM_BROWSERS')).toEqual([])
  })

  it('berkas non-tes di luar runtime/registry tidak menyentuh kunci katalog (allowlist kosong, ES-14)', () => {
    const offenders = sources().filter((f) => touched(readFileSync(join(SERVER_DIR, f), 'utf8')).length > 0)
    expect(offenders).toEqual([])
  })
})
