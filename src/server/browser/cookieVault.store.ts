// Vault cookie terenkripsi at-rest (Rule 7): AES-256-GCM, IV acak per tulis, AAD = workspaceId (blob tak
// bisa dipindah antar workspace). Kunci 32 byte di SecretStore (VAULT_KEY_NAME). Blob 0600 di dir 0700.
// TTL per domain (dihitung dari save). Tidak ada logging di sini: pemanggil memakai cookieRedact.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_COOKIE_TTL_DAYS, VAULT_KEY_NAME, type CookieDomainInfo } from '../../shared/browser.contract'
import type { SecretStore } from '../envSecrets.store'
import { domainKey, type BrowserCookie } from './cookieImport.parse'
import { vaultDir, vaultFile, workspaceIdFromVaultName } from './profile.paths'

const BLOB_VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES
const MS_PER_DAY = 86_400_000
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const KEY_HEX = /^[0-9a-f]{64}$/

interface DomainEntry { savedAt: number; cookies: BrowserCookie[] }
type Blob = Record<string, DomainEntry>

export interface CookieVault {
  /** Simpan cookie (digabung per domain; domain yang sama diganti, TTL dimulai ulang). */
  save(workspaceId: string, cookies: BrowserCookie[]): void
  /** Cookie yang belum kedaluwarsa, opsional subset domain. */
  load(workspaceId: string, domains?: string[]): BrowserCookie[]
  /** Hapus satu domain, atau seluruh blob bila `domain` kosong (tak butuh kunci: jalur pemulihan). */
  clear(workspaceId: string, domain?: string): void
  /** Domain + jumlah + waktu kedaluwarsa vault (tanpa nilai). */
  listDomains(workspaceId: string): CookieDomainInfo[]
  /** Sapu semua blob dari entri kedaluwarsa (panggil saat start); blob tak terbaca dilaporkan. */
  sweepAll(): { checked: number; failed: string[] }
}

export interface CookieVaultOptions {
  secrets: SecretStore
  /** Root data (default `dataDir()`); diinjeksi untuk test. */
  baseDir?: string
  ttlDays?: number
  now?: () => number
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? 'error'
}

/** Buat vault cookie per workspace. */
export function createCookieVault(opts: CookieVaultOptions): CookieVault {
  const now = opts.now ?? Date.now
  const ttlMs = (opts.ttlDays ?? DEFAULT_COOKIE_TTL_DAYS) * MS_PER_DAY
  const dir = vaultDir(opts.baseDir)

  function getKey(create: boolean): Buffer | null {
    let hex = opts.secrets.read(VAULT_KEY_NAME)
    if (hex === null) {
      if (!create) return null
      hex = randomBytes(KEY_BYTES).toString('hex')
      opts.secrets.write(VAULT_KEY_NAME, hex)
    }
    if (!KEY_HEX.test(hex)) throw new Error('cookie vault: stored key is malformed')
    return Buffer.from(hex, 'hex')
  }

  function decrypt(workspaceId: string, file: string): Blob {
    const key = getKey(false)
    if (!key) throw new Error(`cookie vault: key unavailable, blob unreadable (workspace ${workspaceId})`)
    try {
      const raw = readFileSync(file)
      if (raw.length < HEADER_BYTES || raw[0] !== BLOB_VERSION) throw new Error('bad header')
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(1, 1 + IV_BYTES))
      d.setAAD(Buffer.from(workspaceId))
      d.setAuthTag(raw.subarray(1 + IV_BYTES, HEADER_BYTES))
      const json = Buffer.concat([d.update(raw.subarray(HEADER_BYTES)), d.final()]).toString('utf8')
      return (JSON.parse(json) as { domains: Blob }).domains
    } catch {
      // Pesan asli (auth gagal / JSON) tak berguna dan berisiko memuat isi: ganti dengan konteks.
      throw new Error(`cookie vault: cannot decrypt blob, tampered or wrong key (workspace ${workspaceId})`)
    }
  }

  function writeBlob(workspaceId: string, file: string, domains: Blob): void {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    chmodSync(dir, DIR_MODE) // dir hasil buatan lama/tangan: perketat
    const key = getKey(true) as Buffer
    const iv = randomBytes(IV_BYTES)
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(workspaceId))
    const ct = Buffer.concat([c.update(JSON.stringify({ domains }), 'utf8'), c.final()])
    const out = Buffer.concat([Buffer.from([BLOB_VERSION]), iv, c.getAuthTag(), ct])
    const tmp = join(dir, `.${workspaceId}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      writeFileSync(tmp, out, { mode: FILE_MODE, flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* tmp belum terbuat: tak ada yang dibersihkan */ }
      throw new Error(`cookie vault: write failed (workspace ${workspaceId}, ${errCode(err)})`)
    }
  }

  function removeFile(workspaceId: string, file: string): void {
    try { unlinkSync(file) } catch (err) {
      if (errCode(err) !== 'ENOENT') throw new Error(`cookie vault: remove failed (workspace ${workspaceId}, ${errCode(err)})`)
    }
  }

  /** Baca blob, buang domain kedaluwarsa (dan tulis balik bila ada yang dibuang). */
  function read(workspaceId: string): Blob {
    const file = vaultFile(workspaceId, opts.baseDir)
    if (!existsSync(file)) return {}
    const blob = decrypt(workspaceId, file)
    const alive = Object.fromEntries(Object.entries(blob).filter(([, e]) => e.savedAt + ttlMs > now()))
    if (Object.keys(alive).length !== Object.keys(blob).length) {
      if (Object.keys(alive).length === 0) removeFile(workspaceId, file)
      else writeBlob(workspaceId, file, alive)
    }
    return alive
  }

  return {
    save(workspaceId, cookies) {
      const file = vaultFile(workspaceId, opts.baseDir)
      const blob = read(workspaceId)
      const fresh = new Map<string, DomainEntry>() // Map: nama domain aneh (`__proto__`) tak menyentuh prototipe
      for (const c of cookies) {
        const k = domainKey(c.domain)
        fresh.set(k, fresh.get(k) ?? { savedAt: now(), cookies: [] })
        fresh.get(k)!.cookies.push(c)
      }
      writeBlob(workspaceId, file, { ...blob, ...Object.fromEntries(fresh) })
    },
    load(workspaceId, domains) {
      const want = domains && new Set(domains.map(domainKey))
      return Object.entries(read(workspaceId)).filter(([d]) => !want || want.has(d)).flatMap(([, e]) => e.cookies)
    },
    clear(workspaceId, domain) {
      const file = vaultFile(workspaceId, opts.baseDir)
      if (domain === undefined) return removeFile(workspaceId, file)
      const blob = read(workspaceId)
      delete blob[domainKey(domain)]
      if (Object.keys(blob).length === 0) removeFile(workspaceId, file)
      else writeBlob(workspaceId, file, blob)
    },
    listDomains(workspaceId) {
      return Object.entries(read(workspaceId))
        .map(([domain, e]) => ({ domain, count: e.cookies.length, expiresAt: e.savedAt + ttlMs }))
        .sort((a, b) => a.domain.localeCompare(b.domain))
    },
    sweepAll() {
      const ids = existsSync(dir) ? readdirSync(dir).map(workspaceIdFromVaultName).filter((id): id is string => id !== null) : []
      const failed: string[] = []
      for (const id of ids) {
        try { read(id) } catch { failed.push(id) } // pesan sudah ber-konteks; id dikembalikan untuk dilaporkan pemanggil
      }
      return { checked: ids.length, failed }
    },
  }
}
