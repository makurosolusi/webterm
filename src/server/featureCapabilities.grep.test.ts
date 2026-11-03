import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS } from '../shared/featureCapabilities'

// Pagar M2/S-E3: kunci katalog hanya boleh dibaca lewat isEnabled (featureCapabilities.runtime).
const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const KEYS = [...CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey), ...DERIVED_FLAGS.map((d) => d.key)]
const EXEMPT = /(^|\/)(featureCapabilities\.|envRegistry)[^/]*$|\.test\.tsx?$/

// Pelanggar yang SUDAH ada saat ES-00 dibuat. Daftar hanya boleh menyusut: tiap WS menghapus berkasnya
// setelah pindah ke isEnabled; ES-14 mengosongkan (lalu tes ini menolak tambahan baru).
const ALLOWLIST = new Set([
  'central/ca2Boot.ts', 'central/centralApi.ts', 'central/centralAutonomy.ts', 'central/centralModel.ts',
  'central/chat/turnService.ts', 'central/tools/defs/core.defs.ts', 'central/tools/defs/memory.defs.ts',
  'central/tools/defs/read.shared.ts', 'central/tools/registerAll.ts', 'centralAutonomyBoot.ts',
  'centralChatApi.ts', 'centralChatHandlers.ts', 'centralHttp.ts', 'channels/channelsMasterGate.ts',
  'channels/channelsRuntime.ts', 'channels/telegramCentralBridge.ts', 'channels/telegramPollWiring.ts',
  'orchestratorControlService.ts', 'orchestratorRunModel.ts', 'orchestratorRunProduction.ts',
])

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

  it('berkas non-tes di luar runtime/registry tidak menyentuh kunci katalog (kecuali allowlist)', () => {
    const offenders = sources().filter((f) => touched(readFileSync(join(SERVER_DIR, f), 'utf8')).length > 0)
    expect(offenders.filter((f) => !ALLOWLIST.has(f))).toEqual([])
  })

  it('allowlist hanya memuat berkas yang ada', () => {
    const all = new Set(sources().map((f) => relative('.', f)))
    expect([...ALLOWLIST].filter((f) => !all.has(f))).toEqual([])
  })
})
