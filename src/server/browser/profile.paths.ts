// Path profil Chromium + vault cookie per workspace. Semua di bawah dataDir(); workspaceId dari luar
// dianggap tak tepercaya (masuk ke nama file/dir), jadi divalidasi pola aman + dicek tetap di bawah root.
import { isAbsolute, join, relative, resolve } from 'node:path'
import { dataDir } from '../config'

const BROWSER_SUBDIR = 'browser'
const PROFILES_SUBDIR = 'profiles'
const VAULT_SUBDIR = 'vault'
const VAULT_EXT = '.enc'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** True bila `id` aman dipakai sebagai satu segmen path. */
export function isSafeWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id)
}

function under(root: string, target: string, label: string): string {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`browser paths: ${label} escapes data dir`)
  return target
}

/** Akar data browser: `<base>/browser`. `base` default `dataDir()` (diinjeksi untuk test). */
export function browserRoot(base: string = dataDir()): string {
  return join(base, BROWSER_SUBDIR)
}

/** Direktori profil Chromium persisten untuk satu workspace. */
export function profileDir(workspaceId: string, base?: string): string {
  if (!isSafeWorkspaceId(workspaceId)) throw new Error('browser paths: invalid workspace id')
  const root = browserRoot(base)
  return under(root, join(root, PROFILES_SUBDIR, workspaceId), 'profile dir')
}

/** Direktori blob vault terenkripsi. */
export function vaultDir(base?: string): string {
  return join(browserRoot(base), VAULT_SUBDIR)
}

/** Berkas blob vault satu workspace. */
export function vaultFile(workspaceId: string, base?: string): string {
  if (!isSafeWorkspaceId(workspaceId)) throw new Error('browser paths: invalid workspace id')
  const dir = vaultDir(base)
  return under(dir, join(dir, workspaceId + VAULT_EXT), 'vault file')
}

/** Kebalikan `vaultFile`: workspaceId dari nama berkas vault, atau null bila bukan blob vault. */
export function workspaceIdFromVaultName(name: string): string | null {
  if (!name.endsWith(VAULT_EXT)) return null
  const id = name.slice(0, -VAULT_EXT.length)
  return isSafeWorkspaceId(id) ? id : null
}
