import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdirSync, statSync } from 'node:fs'

const DATA_DIR_MODE = 0o700
const tightened = new Set<string>() // sekali per dir per proses: dataDir() sering dipanggil
/** Satu baris stderr berisi kode errno saja (tanpa path/nilai env); boot tetap lanjut. */
export function warnPermsNotTightened(e: unknown): void {
  process.stderr.write(`[webterm] data dir permissions not tightened (${(e as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'})\n`)
}
export function dataDir(): string {
  const dir = process.env.WEBTERM_DATA_DIR || join(homedir(), '.webterm-server')
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  if (process.platform === 'win32' || tightened.has(dir)) return dir
  tightened.add(dir)
  // Hanya dir milik uid proses (dir bersama seperti /tmp bukan hak kita); gagal chmod (Docker/RO) jangan jatuhkan boot.
  try {
    const st = statSync(dir)
    if (st.uid === process.getuid?.() && st.mode & 0o077) chmodSync(dir, DATA_DIR_MODE)
  } catch (e) { warnPermsNotTightened(e) }
  return dir
}

export function dbPath(): string {
  return join(dataDir(), 'webterm.db')
}
