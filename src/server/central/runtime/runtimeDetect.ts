// Deteksi mesin agen Central (ENVSIMPLE D5): CLI yang terpasang di PATH, tanpa spawn proses.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { RuntimeKind } from './centralRuntime'
import { centralClaudeLaunch, type ResolvedClaudeLaunch } from '../../claudeLauncher/claudeLauncher'

/**
 * Nilai `WEBTERM_CENTRAL_RUNTIME` yang dikenal; di luar ini = tak dikenal (fail-closed ke off).
 * `codex` sengaja tidak ada: belum punya adapter, jadi tak boleh tampil "siap".
 */
export const SUPPORTED_RUNTIME_KINDS: ReadonlySet<string> = new Set(['off', 'claude', 'opencode', 'mock'])
const RUNTIME_KEY = 'WEBTERM_CENTRAL_RUNTIME'

/** Penanya "adakah binary ini?"; disuntik supaya tes tak bergantung PATH nyata. */
export type WhichFn = (bin: string) => boolean

/** True bila `bin` ada dan dapat dieksekusi di salah satu direktori `pathVar`; path (`/` di dalamnya) dicek apa adanya. */
export function onPath(bin: string, pathVar: string | undefined = process.env.PATH): boolean {
  if (bin.includes('/')) {
    try { accessSync(bin, constants.X_OK); return true } catch { return false } // tak ada/tak bisa dieksekusi = bukan kandidat
  }
  return (pathVar ?? '').split(delimiter).some((dir) => {
    if (dir === '') return false
    try { accessSync(join(dir, bin), constants.X_OK); return true } catch { return false } // tak ada/tak bisa dieksekusi = bukan kandidat
  })
}

/** Binary yang harus ada di PATH untuk sebuah launch: wrapper (argv[0]) bila ada, selain itu claude. */
export const launchHead = (l: ResolvedClaudeLaunch): string => l.argv[0] ?? 'claude'

/** Label untuk laporan: `envman (via profile Malik)` bila lewat wrapper, selain itu nama binary claude. */
export function launchLabel(l: ResolvedClaudeLaunch): string {
  const head = launchHead(l)
  const name = head.slice(head.lastIndexOf('/') + 1)
  return l.wrapper.length > 0 ? `${name} (via profile ${l.profile.name})` : name
}

/**
 * Mesin eksplisit (`WEBTERM_CENTRAL_RUNTIME` dikenal) menang; selain itu claude, lalu opencode, lalu `off`.
 * claude = binary pertama profil launch Central (wrapper seperti envman bila dipakai).
 * Otomatis TIDAK pernah jatuh ke `mock` (mesin simulasi yang hanya menggemakan teks): mock hanya bila dipilih eksplisit.
 */
export function detectAgentEngine(env: NodeJS.ProcessEnv, which: WhichFn = (bin) => onPath(bin, env.PATH)): RuntimeKind {
  const explicit = (env[RUNTIME_KEY] ?? '').trim().toLowerCase()
  if (SUPPORTED_RUNTIME_KINDS.has(explicit)) return explicit as RuntimeKind
  return which(launchHead(centralClaudeLaunch())) ? 'claude' : which('opencode') ? 'opencode' : 'off'
}
