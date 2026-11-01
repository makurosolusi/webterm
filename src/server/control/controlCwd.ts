// Batas direktori untuk `POST /api/control/spawn`. Dipisah dari `mount.ts` supaya file route
// tetap di bawah budget dan kebijakan ini bisa diuji tanpa HTTP.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, delimiter } from 'node:path'
import { dataDir } from '../config'
import { isInside } from '../transcriptPath'

/**
 * True bila `cwd` adalah direktori nyata di dalam home, data dir, atau root tambahan
 * `WEBTERM_CONTROL_CWD_ROOTS` (dipisah `path.delimiter`). `realpath` menutup symlink yang
 * menunjuk keluar; tanpa batas ini pemegang `node.spawn` bisa menjalankan agent di `/` atau
 * `~/.ssh`.
 */
export function controlCwdAllowed(cwd: string, extraRoots = process.env.WEBTERM_CONTROL_CWD_ROOTS): boolean {
  if (!isAbsolute(cwd)) return false
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    return false
  }
  const extra = (extraRoots ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  for (const root of [homedir(), dataDir(), ...extra]) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    if (isInside(realRoot, real)) return true
  }
  return false
}
