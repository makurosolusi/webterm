import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VAULT_KEY_NAME } from '../../shared/browser.contract'
import type { SecretStore } from '../envSecrets.store'
import type { BrowserCookie } from './cookieImport.parse'
import { createCookieVault } from './cookieVault.store'
import { vaultDir, vaultFile } from './profile.paths'

const CANARY = 'cv-canary-7f3a' // test-only: nilai cookie sintetis
const DAY = 86_400_000
const ck = (domain: string, name = 'sid'): BrowserCookie =>
  ({ name, value: CANARY, domain, path: '/', expires: -1, httpOnly: true, secure: true })

function memSecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, read: (k) => map.get(k) ?? null, write: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) }
}

let base: string
let secrets: ReturnType<typeof memSecrets>
let t: number
const vault = (ttlDays = 7) => createCookieVault({ secrets, baseDir: base, ttlDays, now: () => t })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cv-'))
  secrets = memSecrets()
  t = 1_000_000
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('cookie vault', () => {
  it('round-trips cookies and never writes plaintext to disk', () => {
    const v = vault()
    v.save('ws1', [ck('.a.com'), ck('b.org', 'n2')])
    expect(v.load('ws1').map((c) => `${c.domain}/${c.name}/${c.value}`).sort()).toEqual([`.a.com/sid/${CANARY}`, `b.org/n2/${CANARY}`])
    const raw = readFileSync(vaultFile('ws1', base))
    expect(raw.includes(Buffer.from(CANARY))).toBe(false)
    expect(raw.includes(Buffer.from('a.com'))).toBe(false)
    expect(v.load('ws1', ['A.com']).map((c) => c.domain)).toEqual(['.a.com'])
    expect(v.load('other')).toEqual([])
  })

  it('creates the key lazily: reading an empty vault does not mint one', () => {
    vault().load('ws1')
    expect(secrets.map.has(VAULT_KEY_NAME)).toBe(false)
    vault().save('ws1', [ck('a.com')])
    expect(secrets.map.get(VAULT_KEY_NAME)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses 0600 for the blob and 0700 for the dir', () => {
    vault().save('ws1', [ck('a.com')])
    expect(statSync(vaultFile('ws1', base)).mode & 0o777).toBe(0o600)
    expect(statSync(vaultDir(base)).mode & 0o777).toBe(0o700)
    expect(readdirSync(vaultDir(base)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('detects a tampered byte and a blob moved to another workspace', () => {
    const v = vault()
    v.save('ws1', [ck('a.com')])
    const file = vaultFile('ws1', base)
    const raw = readFileSync(file)
    raw[raw.length - 1] ^= 0xff
    writeFileSync(file, raw)
    expect(() => v.load('ws1')).toThrow(/cannot decrypt blob.*ws1/)
    try { v.load('ws1') } catch (e) { expect((e as Error).message).not.toContain(CANARY) }

    vault().save('ws2', [ck('a.com')])
    copyFileSync(vaultFile('ws2', base), vaultFile('ws3', base))
    expect(() => v.load('ws3')).toThrow(/cannot decrypt blob.*ws3/) // AAD = workspaceId
  })

  it('reports a lost key with context and allows recovery through clear()', () => {
    const v = vault()
    v.save('ws1', [ck('a.com')])
    secrets.map.delete(VAULT_KEY_NAME)
    expect(() => v.load('ws1')).toThrow(/key unavailable.*ws1/)
    expect(() => v.save('ws1', [ck('b.com')])).toThrow(/key unavailable/)
    v.clear('ws1')
    expect(existsSync(vaultFile('ws1', base))).toBe(false)
    v.save('ws1', [ck('b.com')])
    expect(v.listDomains('ws1').map((d) => d.domain)).toEqual(['b.com'])
  })

  it('rejects a malformed stored key', () => {
    secrets.map.set(VAULT_KEY_NAME, 'short')
    expect(() => vault().save('ws1', [ck('a.com')])).toThrow(/key is malformed/)
  })

  it('expires per domain by the injected clock and purges lazily', () => {
    const v = vault(7)
    v.save('ws1', [ck('old.com')])
    t += 5 * DAY
    v.save('ws1', [ck('new.com')])
    t += 3 * DAY // old = 8 hari, new = 3 hari
    expect(v.listDomains('ws1')).toEqual([{ domain: 'new.com', count: 1, expiresAt: t - 3 * DAY + 7 * DAY }])
    expect(v.load('ws1').map((c) => c.domain)).toEqual(['new.com'])
    t += 5 * DAY
    expect(v.load('ws1')).toEqual([])
    expect(existsSync(vaultFile('ws1', base))).toBe(false) // blob kosong dihapus
  })

  it('merges domains on save, replaces the same domain and restarts its TTL', () => {
    const v = vault()
    v.save('ws1', [ck('a.com', 'one')])
    v.save('ws1', [ck('b.com')])
    v.save('ws1', [ck('.a.com', 'two')])
    const all = v.load('ws1')
    expect(all.map((c) => c.name).sort()).toEqual(['sid', 'two'])
    expect(v.listDomains('ws1').map((d) => `${d.domain}:${d.count}`)).toEqual(['a.com:1', 'b.com:1'])
  })

  it('clears one domain or everything', () => {
    const v = vault()
    v.save('ws1', [ck('a.com'), ck('b.com')])
    v.clear('ws1', '.A.com')
    expect(v.listDomains('ws1').map((d) => d.domain)).toEqual(['b.com'])
    v.clear('ws1', 'b.com')
    expect(existsSync(vaultFile('ws1', base))).toBe(false)
    v.clear('ws1') // tak ada berkas: bukan galat
  })

  it('lists domains without leaking cookie values', () => {
    const v = vault()
    v.save('ws1', [ck('a.com')])
    expect(JSON.stringify(v.listDomains('ws1'))).not.toContain(CANARY)
  })

  it('handles prototype-like domain names as plain keys', () => {
    const v = vault()
    v.save('ws1', [ck('__proto__')])
    expect(v.listDomains('ws1').map((d) => d.domain)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).cookies).toBeUndefined()
  })

  it('rejects unsafe workspace ids before touching the disk', () => {
    expect(() => vault().save('../evil', [ck('a.com')])).toThrow(/invalid workspace id/)
    expect(existsSync(vaultDir(base))).toBe(false)
  })

  it('sweepAll purges expired blobs on start and reports unreadable ones', () => {
    const v = vault(1)
    v.save('ws1', [ck('a.com')])
    v.save('ws2', [ck('a.com')])
    writeFileSync(vaultFile('ws3', base), Buffer.from('garbage-not-a-blob-garbage-not-a-blob-garbage'))
    t += 2 * DAY
    expect(v.sweepAll()).toEqual({ checked: 3, failed: ['ws3'] })
    expect(existsSync(vaultFile('ws1', base))).toBe(false)
    expect(existsSync(vaultFile('ws2', base))).toBe(false)
  })
})
