// Validasi path transcript claude. Dipisah dari `agentStatusApi` supaya `contextLink` bisa
// memakainya saat MEMBACA tanpa membentuk impor melingkar (agentStatusApi -> contextLink).
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, dirname, basename, sep } from 'node:path'
import { claudeProjectsRoot } from './transcriptPresence'
import { dataDir } from './config'

/**
 * Root yang boleh memuat sebuah `transcript_path`. `claudeProjectsRoot()` sudah menghormati
 * `CLAUDE_CONFIG_DIR`; `dataDir()` adalah root data webterm sendiri.
 */
export function transcriptRoots(): string[] {
  return [claudeProjectsRoot(), dataDir()]
}

/** Apakah `candidate` benar-benar (bukan hanya secara leksikal) berada di bawah `root`? */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  // `..foo` adalah nama file biasa di dalam root; hanya `..` tersendiri yang keluar.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * `realpath` yang tidak melempar untuk leaf yang belum ada: bagian yang hilang disusun kembali di
 * atas realpath ancestor terdekat. Dengan begitu symlink di tengah path tetap diikuti (escape
 * lewat symlink tertangkap), sementara hook yang melaporkan file yang baru akan dibuat tetap sah.
 */
export function realpathLoose(path: string): string | null {
  let cursor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const real = realpathSync(cursor)
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return null
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Validasi path transcript untuk mode strict. Ditolak bila path bukan absolut, mengandung segmen
 * `..`, atau setelah `realpath` keluar dari root yang diizinkan (termasuk lewat symlink).
 * Fungsi murni terhadap filesystem, tanpa membaca isi file.
 */
export function transcriptPathAllowed(
  path: string,
  roots: string[] = transcriptRoots()
): boolean {
  if (path.includes('\0')) return false
  if (!isAbsolute(path)) return false
  if (path.split(/[\\/]+/).includes('..')) return false
  const target = realpathLoose(path)
  if (!target) return false
  for (const root of roots) {
    const realRoot = realpathLoose(root) ?? resolve(root)
    if (isInside(realRoot, target)) return true
  }
  return false
}
