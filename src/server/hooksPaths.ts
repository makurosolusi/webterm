import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config'

/**
 * Nama file di-hash, bukan `nodeId` mentah: id itu datang dari client lewat WebSocket dan tidak
 * pernah divalidasi sebagai nama file, jadi memakainya langsung adalah path traversal.
 */
export function claudeSettingsPath(nodeId: string): string {
  const name = hashId(nodeId)
  return join(dataDir(), 'node-settings', `${name}.json`)
}

/** Nama file di-hash dengan alasan yang sama seperti `claudeSettingsPath`. */
export function claudeHeadersPath(nodeId: string): string {
  return join(dataDir(), 'node-settings', `${hashId(nodeId)}.headers`)
}

function hashId(nodeId: string): string {
  return createHash('sha256').update(nodeId).digest('hex').slice(0, 16)
}

/** Direktori bersama file settings + file header. 0700: ia kini memuat token hidup. */
export function ensureNodeSettingsDir(): string {
  const dir = join(dataDir(), 'node-settings')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `recursive` tidak menyempitkan direktori yang sudah ada dari versi sebelumnya, jadi mode-nya
  // dipersempit eksplisit. Dilewati di Windows, yang tidak punya mode POSIX.
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}
