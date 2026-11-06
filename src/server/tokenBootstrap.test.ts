import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapToken,
  getTokenState,
  mintToken,
  persistToken,
  setTokenState,
  tokenFilePath,
} from './tokenBootstrap'

const FIXED = 'A'.repeat(43)
const ENV_TOKEN = 'E'.repeat(40)
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/

let root: string
let secretsDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokboot-'))
  secretsDir = join(root, 'secrets')
})
afterEach(() => {
  setTokenState({ token: undefined, source: 'none', created: false })
  rmSync(root, { recursive: true, force: true })
})

const mode = (p: string): number => statSync(p).mode & 0o777
const seed = (content: string, fileMode = 0o600): string => {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
  const p = tokenFilePath(secretsDir)
  writeFileSync(p, content, { mode: fileMode })
  chmodSync(p, fileMode)
  return p
}

describe('bootstrapToken', () => {
  it('env menang atas berkas dan berkas tak disentuh', () => {
    const p = seed(FIXED)
    const before = statSync(p).mtimeMs
    const s = bootstrapToken({ env: { WEBTERM_TOKEN: `  ${ENV_TOKEN} ` }, secretsDir })
    expect(s).toEqual({ token: ENV_TOKEN, source: 'env', created: false })
    expect(statSync(p).mtimeMs).toBe(before)
    expect(readFileSync(p, 'utf8')).toBe(FIXED)
  })

  it('env hanya spasi dianggap kosong dan jatuh ke berkas', () => {
    seed(FIXED)
    expect(bootstrapToken({ env: { WEBTERM_TOKEN: '   ' }, secretsDir })).toEqual({
      token: FIXED, source: 'file', created: false,
    })
  })

  it('memakai berkas bila env kosong (isi di-trim)', () => {
    seed(`${FIXED}\n`)
    expect(bootstrapToken({ env: {}, secretsDir })).toEqual({
      token: FIXED, source: 'file', created: false,
    })
  })

  it('no env and no file => minted, 0600/0700, on every bind (loopback is credentialed too); the second boot reads the disk', () => {
    expect(existsSync(secretsDir)).toBe(false)
    const first = bootstrapToken({ env: {}, secretsDir })
    expect(first.source).toBe('file')
    expect(first.created).toBe(true)
    expect(first.token).toHaveLength(43)
    expect(first.token).toMatch(TOKEN_SHAPE)
    expect(mode(secretsDir)).toBe(0o700)
    expect(mode(tokenFilePath(secretsDir))).toBe(0o600)

    const second = bootstrapToken({ env: {}, secretsDir })
    expect(second).toEqual({ token: first.token, source: 'file', created: false })
    expect(readFileSync(tokenFilePath(secretsDir), 'utf8')).toBe(first.token)
  })

  it('generate injeksi dipakai untuk token baru', () => {
    const s = bootstrapToken({ env: {}, secretsDir, generate: () => FIXED })
    expect(s).toEqual({ token: FIXED, source: 'file', created: true })
  })

  it.each([['kosong', ''], ['ngawur', 'not a token!!'], ['terlalu pendek', 'short']])(
    'berkas %s => throw berisi path, tanpa isi, dan tidak ditimpa',
    (_label, content) => {
      const p = seed(content)
      let msg = ''
      try { bootstrapToken({ env: {}, secretsDir }) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('token file unreadable or malformed')
      expect(msg).toContain(p)
      if (content) expect(msg).not.toContain(content)
      expect(readFileSync(p, 'utf8')).toBe(content)
    },
  )

  it('berkas mode 0644 => throw tanpa membocorkan token', () => {
    const p = seed(FIXED, 0o644)
    let msg = ''
    try { bootstrapToken({ env: {}, secretsDir }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain(p)
    expect(msg).not.toContain(FIXED)
    expect(readFileSync(p, 'utf8')).toBe(FIXED)
  })
})

describe('persistToken / mintToken', () => {
  it('persistToken melempar bila store menyimpan nilai beda, tanpa membocorkan token', () => {
    const store = {
      read: () => 'B'.repeat(43),
      write: () => undefined,
      remove: () => undefined,
    }
    let msg = ''
    try { persistToken(secretsDir, FIXED, store) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain(tokenFilePath(secretsDir))
    expect(msg).not.toContain(FIXED)
  })

  it('persistToken menulis berkas 0600 yang cocok', () => {
    persistToken(secretsDir, FIXED)
    expect(readFileSync(tokenFilePath(secretsDir), 'utf8')).toBe(FIXED)
    expect(mode(tokenFilePath(secretsDir))).toBe(0o600)
  })

  it('mintToken acak 43 karakter base64url dan menghormati generate', () => {
    const a = mintToken()
    expect(a).toMatch(TOKEN_SHAPE)
    expect(a).toHaveLength(43)
    expect(mintToken()).not.toBe(a)
    expect(mintToken(() => FIXED)).toBe(FIXED)
  })
})

describe('holder state', () => {
  it('awal none dan berubah lewat setTokenState', () => {
    expect(getTokenState()).toEqual({ token: undefined, source: 'none', created: false })
    const next = { token: FIXED, source: 'file', created: true } as const
    setTokenState(next)
    expect(getTokenState()).toBe(next)
  })
})
