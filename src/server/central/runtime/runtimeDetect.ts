// Deteksi mesin agen Central (ENVSIMPLE D5): CLI yang terpasang di PATH, tanpa spawn proses.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { RuntimeKind } from './centralRuntime'

/**
 * Nilai `WEBTERM_CENTRAL_RUNTIME` yang dikenal; di luar ini = tak dikenal (fail-closed ke off).
 * `codex` sengaja tidak ada: belum punya adapter, jadi tak boleh tampil "siap".
 */
export const SUPPORTED_RUNTIME_KINDS: ReadonlySet<string> = new Set(['off', 'claude', 'opencode', 'mock'])
const RUNTIME_KEY = 'WEBTERM_CENTRAL_RUNTIME'

/** Penanya "adakah binary ini?"; disuntik supaya tes tak bergantung PATH nyata. */
export type WhichFn = (bin: string) => boolean

/** True bila `bin` ada dan dapat dieksekusi di salah satu direktori `pathVar`. */
export function onPath(bin: string, pathVar: string | undefined = process.env.PATH): boolean {
  return (pathVar ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false
    try { accessSync(join(dir, bin), constants.X_OK); return true } catch { return false } // tak ada/tak bisa dieksekusi = bukan kandidat
  })
}

/**
 * Mesin eksplisit (`WEBTERM_CENTRAL_RUNTIME` dikenal) menang; selain itu claude, lalu opencode, lalu `off`.
 * Otomatis TIDAK pernah jatuh ke `mock` (mesin simulasi yang hanya menggemakan teks): mock hanya bila dipilih eksplisit.
 */
export function detectAgentEngine(env: NodeJS.ProcessEnv, which: WhichFn = (bin) => onPath(bin, env.PATH)): RuntimeKind {
  const explicit = (env[RUNTIME_KEY] ?? '').trim().toLowerCase()
  if (SUPPORTED_RUNTIME_KINDS.has(explicit)) return explicit as RuntimeKind
  return which('claude') ? 'claude' : which('opencode') ? 'opencode' : 'off'
}
