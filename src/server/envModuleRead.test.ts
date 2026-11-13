// Penjaga F2 (RND/51): env yang dibaca di LEVEL MODUL membeku saat impor, jadi lolos dari overlay Settings.
// Hanya daftar putih ini yang boleh; modul baru wajib membaca env lewat parameter/fungsi.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER_DIR = __dirname
// Level modul, bukan fungsi panah (`=>` = dibaca saat dipanggil).
const MODULE_ENV_READ = /^(export )?const (?!.*=>).*process\.env/m
const TEST_FILE = /\.(test|testutil)\.tsx?$/
// Entry bootstrap: membaca env sebelum overlay Settings ada, memang tempatnya (urutan boot dipegang EM-14).
const ENTRY_FILES = new Set(['index.ts', 'server.main.ts'])
// Dibekukan sengaja: tiap berkas punya alasan (kunci keamanan bootstrap / logger sebelum Settings siap).
export const ALLOWED_MODULE_ENV_READS = ['launchLine.ts', 'agentStatusAuth.ts', 'logs/logger.ts', 'logs/logBus.ts'] as const

/** Berkas (relatif ke src/server) yang membaca process.env di level modul, di luar daftar putih; `stale` = entri daftar putih tanpa kecocokan. */
export function scanModuleEnvReads(files: ReadonlyMap<string, string>, allowed: readonly string[]): { offenders: string[]; stale: string[] } {
  const hits = new Set([...files].filter(([path, src]) => MODULE_ENV_READ.test(src) && !ENTRY_FILES.has(path)).map(([path]) => path))
  return { offenders: [...hits].filter((p) => !allowed.includes(p)).sort(), stale: allowed.filter((p) => !hits.has(p)) }
}

function loadServerSources(): Map<string, string> {
  const files = new Map<string, string>()
  for (const rel of readdirSync(SERVER_DIR, { recursive: true }) as string[]) {
    const path = rel.split('\\').join('/')
    if (/\.tsx?$/.test(path) && !TEST_FILE.test(path)) files.set(path, readFileSync(join(SERVER_DIR, path), 'utf8'))
  }
  return files
}

describe('env dibaca di level modul (F2)', () => {
  it('pohon nyata: hanya daftar putih, dan tak ada entri daftar putih yang basi', () => {
    const { offenders, stale } = scanModuleEnvReads(loadServerSources(), ALLOWED_MODULE_ENV_READS)
    expect({ offenders, stale }).toEqual({ offenders: [], stale: [] })
  })

  it('negatif: modul baru dengan pembacaan level modul dilaporkan', () => {
    const files = new Map([['newFeature.ts', 'export const LIMIT = Number(process.env.WEBTERM_NEW_LIMIT)\n']])
    expect(scanModuleEnvReads(files, []).offenders).toEqual(['newFeature.ts'])
  })

  it('negatif: entri daftar putih yang tak cocok apa pun dilaporkan basi', () => {
    const files = new Map([['launchLine.ts', 'export const PORT = Number(process.env.PORT) || 8700\n']])
    expect(scanModuleEnvReads(files, ['launchLine.ts', 'dummy.ts'])).toEqual({ offenders: [], stale: ['dummy.ts'] })
  })

  it('fungsi panah yang menyebut process.env dan berkas tes tidak dihitung', () => {
    const files = new Map([['feature.ts', 'const flagged = (ctx: C): boolean => flagOn((ctx.env ?? process.env)[flag])\n']])
    expect(scanModuleEnvReads(files, []).offenders).toEqual([])
  })
})
