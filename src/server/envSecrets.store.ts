// Secret env di file `<dir>/<KEY>` mode 0600, dir 0700 — BUKAN di webterm.db (mode 0644, ikut
// ter-backup/dump). Tulis atomik temp+rename; mode diset saat dibuat (bukan chmod sesudahnya),
// jadi tak ada jendela di mana isi terbaca grup/lain. Nilai tak pernah masuk pesan error.
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readSecretFile } from './channels/channelSecret'

export interface SecretStore {
  /** Isi secret, atau null bila tak ada / tak terbaca / mode salah. */
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
}

const KEY_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

function checkKey(key: string): void {
  if (!KEY_SHAPE.test(key)) throw new Error('secret store: invalid key name')
}

/** Store berbasis file di `dir` (dibuat 0700 bila belum ada). */
export function createFileSecretStore(dir: string): SecretStore {
  const pathOf = (key: string): string => join(dir, key)

  function ensureDir(key: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE })
      return
    }
    // Direktori hasil buatan lama/tangan: perketat, jangan menulis secret ke dir yang terbuka.
    if ((statSync(dir).mode & 0o077) !== 0) {
      try { chmodSync(dir, DIR_MODE) } catch (err) {
        throw new Error(`secret store: cannot restrict directory for ${key} (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }
  }

  return {
    read(key) {
      checkKey(key)
      const file = pathOf(key)
      if (!existsSync(file)) return null
      const got = readSecretFile(file)
      return got.ok ? got.text.trim() : null
    },
    write(key, value) {
      checkKey(key)
      ensureDir(key)
      const tmp = join(dir, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      try {
        writeFileSync(tmp, value, { mode: FILE_MODE, flag: 'wx' })
        renameSync(tmp, pathOf(key))
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* tmp belum ada: tak ada yang dibersihkan */ }
        throw new Error(`secret store: write failed for ${key} (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    },
    remove(key) {
      checkKey(key)
      try { unlinkSync(pathOf(key)) } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw new Error(`secret store: remove failed for ${key} (${code ?? 'error'})`)
      }
    },
  }
}
