// Sakelar Shields per situs (seperti Brave Shields): host yang pemblokirannya dimatikan pengguna, dipersist
// sebagai JSON kecil di data dir. Default semua situs ON; hanya pengecualian yang disimpan.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RequestType } from '@ghostery/adblocker'
import { createLogger } from '../logs'
import type { Adblock, AdblockVerdict } from './adblock.engine'

const log = createLogger('browser.shields')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Nama berkas daftar host yang Shields-nya dimatikan. */
export const SHIELDS_FILE = 'shields-off.json'

/** Kebijakan blokir yang dipakai host browser: putusan mesin filter + sakelar per situs. */
export interface ShieldPolicy {
  check(url: string, sourceUrl: string, type: RequestType): AdblockVerdict
  isOff(host: string): boolean
  setOff(host: string, off: boolean): void
}

function readHosts(file: string): Set<string> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(v)) return new Set(v.filter((h): h is string => typeof h === 'string'))
    log.warn('shields.load', 'shields file is not a list; starting with blocking on everywhere', {})
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('shields.load', 'shields file unreadable; starting with blocking on everywhere', { error: errMsg(err) })
  }
  return new Set()
}

/** Gabungkan mesin filter dengan daftar situs-off yang dipersist di `dir`. */
export function createShieldPolicy(adblock: Adblock, dir: string): ShieldPolicy {
  const file = join(dir, SHIELDS_FILE)
  const off = readHosts(file)
  return {
    check: (url, sourceUrl, type) => adblock.check(url, sourceUrl, type),
    isOff: (host) => off.has(host.toLowerCase()),
    setOff(host, isOff) {
      const h = host.toLowerCase()
      if (isOff === off.has(h)) return
      if (isOff) off.add(h)
      else off.delete(h)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify([...off].sort()))
        renameSync(`${file}.tmp`, file)
      } catch (err) {
        throw new Error(`saving shields setting for ${h} failed: ${errMsg(err)}`, { cause: err })
      }
    },
  }
}
