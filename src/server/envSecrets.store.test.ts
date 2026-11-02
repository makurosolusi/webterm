// Store secret berbasis file: mode 0600/0700 sejak dibuat, tulis atomik, kompatibel dengan readSecretFile.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSecretFile } from './channels/channelSecret'
import { createFileSecretStore } from './envSecrets.store'
import { SENTINEL_BOT_TOKEN } from './envSettings.testutil'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'envsec-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const mode = (p: string): number => statSync(p).mode & 0o777
const KEY = 'WEBTERM_TELEGRAM_BOT_TOKEN'

describe('createFileSecretStore', () => {
  it('membuat dir 0700 + file 0600 dan bisa dibaca readSecretFile', () => {
    const dir = join(root, 'secrets')
    const store = createFileSecretStore(dir)
    store.write(KEY, SENTINEL_BOT_TOKEN)
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, KEY))).toBe(0o600)
    expect(readSecretFile(join(dir, KEY))).toEqual({ ok: true, text: SENTINEL_BOT_TOKEN })
    expect(store.read(KEY)).toBe(SENTINEL_BOT_TOKEN)
  })

  it('menimpa atomik tanpa sisa file sementara; file lama berizin longgar jadi 0600', () => {
    const dir = join(root, 'secrets')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, KEY), 'old', { mode: 0o644 })
    chmodSync(join(dir, KEY), 0o644)
    const store = createFileSecretStore(dir)
    expect(store.read(KEY)).toBeNull() // mode longgar ditolak readSecretFile
    store.write(KEY, SENTINEL_BOT_TOKEN)
    expect(mode(join(dir, KEY))).toBe(0o600)
    expect(readdirSync(dir)).toEqual([KEY])
  })

  it('memperketat dir lama yang terbuka sebelum menulis', () => {
    const dir = join(root, 'open')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    createFileSecretStore(dir).write(KEY, SENTINEL_BOT_TOKEN)
    expect(mode(dir)).toBe(0o700)
  })

  it('remove idempoten; read tanpa file null', () => {
    const store = createFileSecretStore(join(root, 'secrets'))
    expect(store.read(KEY)).toBeNull()
    store.write(KEY, SENTINEL_BOT_TOKEN)
    store.remove(KEY)
    store.remove(KEY)
    expect(store.read(KEY)).toBeNull()
  })

  it('menolak nama kunci yang bisa keluar dari direktori', () => {
    const store = createFileSecretStore(join(root, 'secrets'))
    for (const bad of ['../x', 'a/b', 'lower', '']) {
      expect(() => store.write(bad, 'v')).toThrow('invalid key name')
      expect(() => store.read(bad)).toThrow('invalid key name')
    }
  })

  it('error tulis menyebut kunci + kode, tanpa nilai', () => {
    const blocker = join(root, 'file-not-dir')
    writeFileSync(blocker, 'x')
    try { createFileSecretStore(blocker).write(KEY, SENTINEL_BOT_TOKEN); expect.unreachable() } catch (err) {
      expect(String(err)).toContain(KEY)
      expect(String(err)).not.toContain('SENTINEL')
    }
  })
})
