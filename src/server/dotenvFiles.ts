// Provenance `.env`: kunci mana di process.env yang sebenarnya datang dari berkas dotenv (Bun
// memuatnya otomatis dari cwd). Dipakai ptyEnv supaya kunci asal `.env` tidak bocor ke shell anak.
// Berkas hanya dibaca ke memori; NILAI tak pernah dicetak/di-log — hanya NAMA kunci yang keluar.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { CREDENTIAL_VARS, PROVIDER_ENV_ALLOWLIST } from './agentEnv'

/** Berkas lebih besar dari ini dilewati (bukan dotenv wajar; jangan muatkan ke memori). */
export const DOTENV_MAX_BYTES = 256 * 1024
const BASE_FILES = ['.env', '.env.local'] as const
const PRODUCTION_FILE = '.env.production'
const DEVELOPMENT_FILE = '.env.development'

export interface DotenvBoot { readonly cwd: string; readonly keys: ReadonlySet<string> }

type Read = (path: string) => string | null

/** Baca berkas; `null` = tidak ada atau terlalu besar. Galat lain dilempar dengan nama berkas (tanpa isi). */
function readFileOrNull(path: string): string | null {
  try {
    if (statSync(path).size > DOTENV_MAX_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw new Error(`dotenv: cannot read ${path} (${code ?? 'unknown'})`, { cause: e })
  }
}

/** Kunci process.env yang nilainya SAMA dengan hasil parse berkas dotenv di `cwd`. Shell yang menimpa
 *  `.env` (Bun: shell menang) otomatis tidak masuk karena nilainya beda. */
export function dotenvKeys(i: { cwd: string; env: NodeJS.ProcessEnv; read?: Read }): ReadonlySet<string> {
  const read = i.read ?? readFileOrNull
  const specific = i.env.NODE_ENV === 'production' ? PRODUCTION_FILE : DEVELOPMENT_FILE
  const merged: Record<string, string> = {}
  // Urutan prioritas naik: .env < .env.local < berkas per-lingkungan (cermin Bun).
  for (const name of [...BASE_FILES, specific]) {
    const text = read(join(i.cwd, name))
    if (text === null || Buffer.byteLength(text) > DOTENV_MAX_BYTES) continue
    Object.assign(merged, parseEnv(text))
  }
  return new Set(Object.keys(merged).filter((k) => i.env[k] === merged[k]))
}

let recorded: DotenvBoot | undefined

/** Catat provenance SEKALI per proses. Wajib dipanggil sebelum overlay Settings memutasi process.env. */
export function recordDotenvBoot(cwd: string, env: NodeJS.ProcessEnv): DotenvBoot {
  recorded ??= { cwd, keys: dotenvKeys({ cwd, env }) }
  return recorded
}

/** Provenance yang tercatat; sebelum `recordDotenvBoot` = kosong (tak ada yang disapu). */
export function getDotenvBoot(): DotenvBoot {
  return recorded ?? { cwd: process.cwd(), keys: new Set() }
}

const OS_KEEP = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK'])
const PROVIDER_KEEP = new Set(PROVIDER_ENV_ALLOWLIST.filter((k) => !CREDENTIAL_VARS.includes(k)))

/** Kunci yang tetap diteruskan ke PTY walau asalnya `.env`: kunci provider non-kredensial (kredensial dipegang proxy) + kunci OS. */
export const PTY_KEEP_FROM_DOTENV = (key: string): boolean =>
  OS_KEEP.has(key) || key.startsWith('LC_') || PROVIDER_KEEP.has(key)
